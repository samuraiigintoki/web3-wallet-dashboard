import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, isApiError, type Wallet } from '../api/index.ts'
import type { DataSession } from '../auth/session.ts'
import type { IdentityRef } from '../data/identityKeys.ts'
import { walletFieldErrorsFrom, type WalletFormField } from '../forms/serverErrors.ts'

/**
 * One label save, bound to the identity, the row and the attempt that started
 * it.
 *
 * The tuple is deliberately wider than the create hook's. A create can only be
 * started by one form, so user and generation are enough; an update can be
 * started from any row on the page, and a draft moved from one row to another
 * while a request is open would otherwise let a late answer for row A settle
 * into row B's editor. Adding the wallet id and an attempt counter closes that.
 */

export type UpdateLabelInput = {
  walletId: number
  label: string
}

export type UpdateLabelFailure = {
  error: ApiError
  /** Field-keyed messages from a 422. Empty for every other failure. */
  fieldErrors: Partial<Record<WalletFormField, string>>
}

export type UpdateLabelState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'saved'; wallet: Wallet }
  | ({ status: 'failed' } & UpdateLabelFailure)

export type UseUpdateWalletLabelOptions = {
  dataSession: DataSession | null
  /** The row this editor is open for. A change retires whatever was in flight. */
  walletId: number
  /**
   * Runs once, after a save confirmed to belong to the identity still presented
   * and to the row still open. It refreshes that identity's list pages without
   * touching the URL, because a label change moves no totals and no ordering.
   */
  onUpdated: (identity: IdentityRef, wallet: Wallet) => void
}

function toFailure(error: unknown): UpdateLabelFailure {
  // The request helper translates every outcome into an ApiError, so a raw
  // TypeError never reaches here.
  const apiError = isApiError(error)
    ? error
    : new ApiError({
        code: 'UNEXPECTED_RESPONSE',
        status: 0,
        message: 'the update failed for a reason this client does not understand',
      })

  return { error: apiError, fieldErrors: walletFieldErrorsFrom(apiError) }
}

export function useUpdateWalletLabel({
  dataSession,
  walletId,
  onUpdated,
}: UseUpdateWalletLabelOptions): {
  state: UpdateLabelState
  submit: (input: UpdateLabelInput) => Promise<void>
  reset: () => void
} {
  const [state, setState] = useState<UpdateLabelState>({ status: 'idle' })

  /**
   * The identity as it stands now, read through a ref rather than from the
   * closure that started the request. Checking an answer against the captured
   * value would always succeed, because it is by definition the identity the
   * request started under; the question is whether that identity is still the
   * one being presented.
   */
  const identityRef = useRef<IdentityRef | null>(
    dataSession === null
      ? null
      : { userId: dataSession.userId, generation: dataSession.generation },
  )

  /** The latest callback, for the same reason the identity is a ref. */
  const onUpdatedRef = useRef(onUpdated)

  useEffect(() => {
    onUpdatedRef.current = onUpdated
  }, [onUpdated])

  const controllerRef = useRef<AbortController | null>(null)
  const submittingRef = useRef(false)

  /**
   * The attempt counter.
   *
   * A retarget remounts this hook with a new wallet id, so the id alone already
   * separates two editors. The counter separates two submissions of the same
   * editor, which matters when an answer arrives after the user has already
   * closed a failure and tried again.
   */
  const attemptRef = useRef(0)

  /** Which attempt's answer is allowed to be applied. */
  const liveAttemptRef = useRef(0)

  const userId = dataSession?.userId ?? null
  const generation = dataSession?.generation ?? null

  /**
   * The identity this hook's state belongs to.
   *
   * A credential replacement for the same user is a different identity, so it
   * gets a different stamp, and the state below is derived from it during
   * render rather than reset in an effect. Deriving is what makes a superseded
   * identity's "saved" or "failed" unreachable in the next render instead of
   * visible for one frame after the switch.
   */
  const identityStamp = `${String(userId)}:${String(generation)}`
  const [stateStamp, setStateStamp] = useState(identityStamp)

  if (stateStamp !== identityStamp) {
    setStateStamp(identityStamp)
    setState({ status: 'idle' })
  }

  useEffect(() => {
    const next =
      userId === null || generation === null ? null : { userId, generation }

    identityRef.current = next

    // The identity moved on, so whatever this editor owned is retired. A held
    // answer that arrives afterwards finds its identity gone and does nothing,
    // which is the only behaviour that is safe for a late success and a late
    // 401 alike. The controller is the external system here; the rendered state
    // was already dealt with above.
    attemptRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
    submittingRef.current = false
  }, [userId, generation])

  // Unmount retires owned work the same way. Closing the editor, cancelling it
  // and retargeting it to another row all end in this effect.
  useEffect(
    () => () => {
      attemptRef.current += 1
      controllerRef.current?.abort()
      controllerRef.current = null
      submittingRef.current = false
    },
    [],
  )

  const isLive = useCallback(
    (identity: IdentityRef, attempt: number): boolean =>
      identityRef.current !== null &&
      identityRef.current.userId === identity.userId &&
      identityRef.current.generation === identity.generation &&
      liveAttemptRef.current === attempt,
    [],
  )

  const reset = useCallback((): void => {
    setState({ status: 'idle' })
  }, [])

  const submit = useCallback(
    async (input: UpdateLabelInput): Promise<void> => {
      if (submittingRef.current || dataSession === null) {
        // A second submit is refused, and so is one with no identity to act as.
        return
      }

      // The caller can only address the row this editor was opened for. A
      // mismatch is a retarget in progress, and that submission is not this
      // editor's to make.
      if (input.walletId !== walletId) {
        return
      }

      const identity: IdentityRef = {
        userId: dataSession.userId,
        generation: dataSession.generation,
      }

      attemptRef.current += 1
      const attempt = attemptRef.current
      liveAttemptRef.current = attempt

      const controller = new AbortController()
      controllerRef.current = controller
      submittingRef.current = true
      setState({ status: 'submitting' })

      try {
        const wallet = await dataSession.client.updateWalletLabel(
          input.walletId,
          { label: input.label },
          { signal: controller.signal },
        )

        // The answer belongs to another identity, or to an attempt this editor
        // has already moved past. Nothing is applied: no message, no refresh.
        if (!isLive(identity, attempt) || controller.signal.aborted) {
          return
        }

        setState({ status: 'saved', wallet })
        onUpdatedRef.current(identity, wallet)
      } catch (error) {
        if (!isLive(identity, attempt) || controller.signal.aborted) {
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
    [dataSession, isLive, walletId],
  )

  return { state, submit, reset }
}
