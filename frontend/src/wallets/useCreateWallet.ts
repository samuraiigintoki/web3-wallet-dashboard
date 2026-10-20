import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, isApiError, type ApiErrorCode, type Wallet } from '../api/index.ts'
import type { DataSession } from '../auth/session.ts'
import type { IdentityRef } from '../data/identityKeys.ts'
import { walletFieldErrorsFrom, type WalletFormField } from '../forms/serverErrors.ts'

/**
 * One wallet create, bound to the identity that started it.
 *
 * This is deliberately not a Query mutation. A mutation would keep its own
 * cached state and its own callbacks, and both outlive the identity in ways
 * this slice has to rule out: a mutation result stays in the cache after the
 * component is gone, and an `onSuccess` that fires late would need the same
 * identity check this hook makes before it did anything. The lifetime rules are
 * shorter to state and easier to prove against a controller the hook owns.
 */

export type CreateWalletInput = {
  address: string
  chainId: number
  label: string
}

export type CreateWalletFailure = {
  error: ApiError
  /** Field-keyed messages from a 422. Empty for every other failure. */
  fieldErrors: Partial<Record<WalletFormField, string>>
}

export type CreateWalletState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'saved'; wallet: Wallet }
  | ({ status: 'failed' } & CreateWalletFailure)

export type UseCreateWalletOptions = {
  dataSession: DataSession | null
  /**
   * Runs once, after a save that is confirmed to belong to the identity still
   * presented. It refreshes that identity's list pages and returns the URL to
   * page 1. It never runs for a late answer.
   */
  onSaved: (identity: IdentityRef) => void
}

/**
 * Whether a failed create left the fate of the write unknown.
 *
 * Two families share that property. A timeout, a dropped connection or a
 * cancelled attempt never reached a verdict. A success-shaped response this
 * client could not verify, malformed JSON, an empty body, a row missing a
 * field the contract requires, is the other: the server answered 2xx, and the
 * row may already be committed. Neither is "not saved", and neither may be
 * retried blind without looking at the server's own list first.
 *
 * A failure the API itself reported is not in this set. A 409, a 422 or a 503
 * is an answer, not an unknown.
 */
const UNCONFIRMED_CODES: readonly ApiErrorCode[] = [
  'TIMEOUT',
  'ABORTED',
  'NETWORK_ERROR',
  'UNEXPECTED_RESPONSE',
]

/**
 * Statuses a gateway sends when it could not deliver or read an answer.
 *
 * The upstream POST may have committed before the gateway lost the response, so
 * an unreadable 502 or 504 says nothing about the row. It is not a verdict.
 */
const GATEWAY_STATUSES: readonly number[] = [502, 504]

export function isUnconfirmedWrite(error: ApiError): boolean {
  if (!UNCONFIRMED_CODES.includes(error.code)) {
    return false
  }

  // An unreadable response means the write's fate is unknown when the status
  // does not rule out a committed row: 2xx, the statusless failure the client
  // raises for a body it could not use, or a gateway that may have lost the
  // answer after the upstream handler ran.
  //
  // An unreadable status the API itself sent is different. A 503 is the service
  // reporting that it did not serve the request, and that stays a plain failure
  // with ordinary advice.
  if (error.code === 'UNEXPECTED_RESPONSE') {
    return (
      error.status === 0 ||
      (error.status >= 200 && error.status < 300) ||
      GATEWAY_STATUSES.includes(error.status)
    )
  }

  return true
}

function toFailure(error: unknown): CreateWalletFailure {
  // Only an ApiError reaches here: the request helper translates every outcome
  // into one, so a raw TypeError never escapes to a component.
  const apiError = isApiError(error)
    ? error
    : new ApiError({
        code: 'UNEXPECTED_RESPONSE',
        status: 0,
        message: 'the save failed for a reason this client does not understand',
      })

  return { error: apiError, fieldErrors: walletFieldErrorsFrom(apiError) }
}

export function useCreateWallet({
  dataSession,
  onSaved,
}: UseCreateWalletOptions): {
  state: CreateWalletState
  submit: (input: CreateWalletInput) => Promise<void>
  reset: () => void
} {
  const [state, setState] = useState<CreateWalletState>({ status: 'idle' })

  /**
   * The identity as it stands now, read through a ref rather than from the
   * closure that started the request.
   *
   * The closure captures the `dataSession` from the render the submit happened
   * in. Checking the answer against that value would always succeed, because it
   * is by definition the identity the request was started under. The question
   * is whether that identity is still the one being presented, which only a ref
   * kept current can answer.
   */
  const identityRef = useRef<IdentityRef | null>(
    dataSession === null
      ? null
      : { userId: dataSession.userId, generation: dataSession.generation },
  )

  /**
   * The callback as it stands now.
   *
   * A submission can outlive the render that started it, and the callback it
   * captured would then be a description of a page the user has since left.
   * Reading the latest one keeps the decision after a save on the current
   * screen. It is still only reached for an answer that belongs to the identity
   * still presented, which is the check above it.
   */
  const onSavedRef = useRef(onSaved)

  useEffect(() => {
    onSavedRef.current = onSaved
  }, [onSaved])

  /** The controller for whatever create is in flight. One at a time. */
  const controllerRef = useRef<AbortController | null>(null)

  /** Guards the door as well as the button: a second submit is refused here. */
  const submittingRef = useRef(false)

  const userId = dataSession?.userId ?? null
  const generation = dataSession?.generation ?? null

  useEffect(() => {
    const next =
      userId === null || generation === null ? null : { userId, generation }

    identityRef.current = next

    // The identity moved on, so whatever this form owned is retired: the
    // request is aborted and the submission state is dropped. A held answer
    // that arrives afterwards finds its identity gone and does nothing at all,
    // which is the only behaviour that is safe for a late success and for a
    // late 401 alike.
    controllerRef.current?.abort()
    controllerRef.current = null
    submittingRef.current = false
    setState({ status: 'idle' })
  }, [userId, generation])

  // Unmount retires owned work the same way, so a component that is going away
  // cannot write to a form or a cache nobody is looking at.
  useEffect(
    () => () => {
      controllerRef.current?.abort()
      controllerRef.current = null
      submittingRef.current = false
    },
    [],
  )

  const isCurrent = useCallback((identity: IdentityRef): boolean => {
    const current = identityRef.current
    return (
      current !== null &&
      current.userId === identity.userId &&
      current.generation === identity.generation
    )
  }, [])

  const reset = useCallback((): void => {
    setState({ status: 'idle' })
  }, [])

  const submit = useCallback(
    async (input: CreateWalletInput): Promise<void> => {
      if (submittingRef.current || dataSession === null) {
        // A second submit is refused, and so is one with no identity to act as.
        return
      }

      const identity: IdentityRef = {
        userId: dataSession.userId,
        generation: dataSession.generation,
      }

      const controller = new AbortController()
      controllerRef.current = controller
      submittingRef.current = true
      setState({ status: 'submitting' })

      try {
        const wallet = await dataSession.client.createWallet(
          {
            address: input.address,
            chainId: input.chainId,
            label: input.label,
          },
          { signal: controller.signal },
        )

        // The answer belongs to another identity. Nothing is applied: no
        // success message, no form reset, no refresh, no URL change.
        if (!isCurrent(identity) || controller.signal.aborted) {
          return
        }

        setState({ status: 'saved', wallet })
        onSavedRef.current(identity)
      } catch (error) {
        // Same fence on the way out. An error for a superseded identity is not
        // this form's failure to report, and a late 401 has already been
        // handled, or correctly ignored, by the auth layer.
        if (!isCurrent(identity) || controller.signal.aborted) {
          return
        }

        setState({ status: 'failed', ...toFailure(error) })
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null
          submittingRef.current = false
        }
      }
    },
    [dataSession, isCurrent],
  )

  return { state, submit, reset }
}
