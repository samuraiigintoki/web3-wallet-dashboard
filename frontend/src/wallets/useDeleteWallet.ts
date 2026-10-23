import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, isApiError, type Wallet } from '../api/index.ts'
import type { DataSession } from '../auth/session.ts'
import type { IdentityRef } from '../data/identityKeys.ts'
import { isUnconfirmedWrite } from './writeOutcome.ts'

/**
 * One removal, and its read-only reconciliation, bound to the identity, the
 * row and the attempt that started each of them.
 *
 * The tuple is the one the label editor uses: user, generation, wallet id and
 * an attempt counter. A delete is a destructive answer to hold, so the same
 * rule applies to both halves. A late answer for a row that has been closed,
 * retargeted or superseded must settle nothing.
 */

export type RemovalState =
  | { status: 'idle' }
  | { status: 'removing' }
  /** The server confirmed with `204 No Content`. The record is gone. */
  | { status: 'removed' }
  /**
   * The server answered `404 RESOURCE_NOT_FOUND`. That is the documented answer
   * for an id that is already unavailable to this owner, not a second receipt
   * and not proof of who removed it.
   */
  | { status: 'unavailable' }
  /** A failure the API itself reported: an answer, not an unknown. */
  | { status: 'failed'; error: ApiError }
  /** An outcome whose fate is unknown. */
  | { status: 'unconfirmed'; error: ApiError }

export type ReconciliationState =
  | { status: 'idle' }
  | { status: 'checking' }
  /** A valid `200` for this id: the record is still there. */
  | { status: 'present'; wallet: Wallet }
  /** A well-formed `404 RESOURCE_NOT_FOUND`: unavailable to this owner. */
  | { status: 'absent' }
  /** A failed read, an unreadable answer or an opaque `404`. */
  | { status: 'indeterminate' }

export type UseDeleteWalletOptions = {
  dataSession: DataSession | null
  /** The row this confirmation is open for. A change retires what is in flight. */
  walletId: number
}

const FALLBACK = new ApiError({
  code: 'UNEXPECTED_RESPONSE',
  status: 0,
  message: 'the removal failed for a reason this client does not understand',
})

function toApiError(error: unknown): ApiError {
  return isApiError(error) ? error : FALLBACK
}

/**
 * Whether a failed delete leaves the fate of the record unknown.
 *
 * Two shapes are called unknown. Everything `isUnconfirmedWrite` already
 * classifies, which is a timeout, a cancellation, a transport failure, a
 * success-shaped answer this client could not use, and an unreadable gateway,
 * plus an unreadable `404`. A `404` from a proxy is not the API's typed
 * `RESOURCE_NOT_FOUND`, so it is not the documented "already unavailable": it
 * may have reached a handler that committed before the answer was lost, and it
 * must not be read as proof of anything.
 */
export function isUnconfirmedRemoval(error: ApiError): boolean {
  if (isUnconfirmedWrite(error)) {
    return true
  }

  return error.status === 404 && error.code !== 'RESOURCE_NOT_FOUND'
}

export function useDeleteWallet({
  dataSession,
  walletId,
}: UseDeleteWalletOptions): {
  state: RemovalState
  check: ReconciliationState
  remove: () => Promise<void>
  verify: () => Promise<void>
  reset: () => void
} {
  const [state, setState] = useState<RemovalState>({ status: 'idle' })
  const [check, setCheck] = useState<ReconciliationState>({ status: 'idle' })

  /**
   * The identity as it stands now, read through a ref rather than from the
   * closure that started the call, for the same reason the label save does:
   * checking an answer against the value it was started with would always
   * succeed, and the question is whether that identity is still presented.
   */
  const identityRef = useRef<IdentityRef | null>(
    dataSession === null
      ? null
      : { userId: dataSession.userId, generation: dataSession.generation },
  )

  const removeControllerRef = useRef<AbortController | null>(null)
  const checkControllerRef = useRef<AbortController | null>(null)
  const workingRef = useRef(false)

  /** The attempt counter. One confirmation is one attempt, one check another. */
  const attemptRef = useRef(0)
  const liveAttemptRef = useRef(0)

  const userId = dataSession?.userId ?? null
  const generation = dataSession?.generation ?? null

  /**
   * The identity this hook's state belongs to.
   *
   * A credential replacement for the same user is a different identity, so the
   * visible state is derived from the stamp during render rather than reset in
   * an effect, which is what makes a superseded identity's answer unreachable
   * in the next render instead of visible for one frame.
   */
  const identityStamp = `${String(userId)}:${String(generation)}`
  const [stateStamp, setStateStamp] = useState(identityStamp)

  if (stateStamp !== identityStamp) {
    setStateStamp(identityStamp)
    setState({ status: 'idle' })
    setCheck({ status: 'idle' })
  }

  const retire = useCallback((): void => {
    attemptRef.current += 1
    removeControllerRef.current?.abort()
    removeControllerRef.current = null
    checkControllerRef.current?.abort()
    checkControllerRef.current = null
    workingRef.current = false
  }, [])

  useEffect(() => {
    identityRef.current =
      userId === null || generation === null ? null : { userId, generation }

    // The identity moved on, so nothing this hook owns may still settle.
    retire()
  }, [userId, generation, retire])

  // Unmount retires owned work the same way.
  useEffect(() => retire, [retire])

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
    setCheck({ status: 'idle' })
  }, [])

  const remove = useCallback(async (): Promise<void> => {
    if (workingRef.current || dataSession === null) {
      // A second confirmation, including one from a double click, is refused
      // here as well as by the disabled buttons.
      return
    }

    const identity: IdentityRef = {
      userId: dataSession.userId,
      generation: dataSession.generation,
    }

    // A new removal retires a check that is still on the wire, so its answer
    // cannot describe the attempt that followed it.
    attemptRef.current += 1
    const attempt = attemptRef.current
    liveAttemptRef.current = attempt

    const controller = new AbortController()
    removeControllerRef.current = controller
    checkControllerRef.current?.abort()
    checkControllerRef.current = null
    workingRef.current = true

    setCheck({ status: 'idle' })
    setState({ status: 'removing' })

    try {
      await dataSession.client.deleteWallet(walletId, { signal: controller.signal })

      // The answer belongs to another identity, or to an attempt this
      // confirmation has already moved past. Nothing is applied: no message,
      // no refresh, no navigation.
      if (!isLive(identity, attempt) || controller.signal.aborted) {
        return
      }

      setState({ status: 'removed' })
    } catch (error) {
      if (!isLive(identity, attempt) || controller.signal.aborted) {
        return
      }

      const apiError = toApiError(error)

      if (apiError.code === 'RESOURCE_NOT_FOUND') {
        // The documented answer for an id that is already gone. Reported as
        // what it is, and never as a new confirmation.
        setState({ status: 'unavailable' })
        return
      }

      setState(
        isUnconfirmedRemoval(apiError)
          ? { status: 'unconfirmed', error: apiError }
          : { status: 'failed', error: apiError },
      )
    } finally {
      if (removeControllerRef.current === controller) {
        removeControllerRef.current = null
        workingRef.current = false
      }
    }
  }, [dataSession, isLive, walletId])

  const verify = useCallback(async (): Promise<void> => {
    if (workingRef.current || dataSession === null) {
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
    checkControllerRef.current = controller
    workingRef.current = true

    setCheck({ status: 'checking' })

    try {
      // One protected read of this one id. It never re-sends the delete, and
      // it reads no credential from shared storage.
      const wallet = await dataSession.client.getWallet(walletId, {
        signal: controller.signal,
      })

      if (!isLive(identity, attempt) || controller.signal.aborted) {
        return
      }

      setCheck({ status: 'present', wallet })
    } catch (error) {
      if (!isLive(identity, attempt) || controller.signal.aborted) {
        return
      }

      const apiError = toApiError(error)

      // Only the API's own typed not-found says anything about this owner's
      // access. A proxy's opaque 404 and a failed read say nothing at all.
      setCheck({
        status: apiError.code === 'RESOURCE_NOT_FOUND' ? 'absent' : 'indeterminate',
      })
    } finally {
      if (checkControllerRef.current === controller) {
        checkControllerRef.current = null
        workingRef.current = false
      }
    }
  }, [dataSession, isLive, walletId])

  return { state, check, remove, verify, reset }
}
