/**
 * A value that is only true while the situation it was produced in still holds.
 *
 * Every control on the event view answers a question about one proposal, asked by
 * one account, on one chain, at one contract address. The answer is stamped with
 * that whole situation, and an answer whose stamp is not the current one is
 * neither drawn nor kept: it describes a screen the user has already left, and
 * drawing it beside a new row would attribute one proposal's facts to another.
 *
 * The reset happens during render rather than in an effect, so no frame ever
 * shows a stale value beside a changed stamp. A null stamp means the situation is
 * not knowable at all (no account, no chain), and nothing can be stored under it.
 *
 * This is the same rule the write hook has always applied; it lives here so that
 * a read-only control and a write control cannot drift about it.
 */

import { useCallback, useState } from 'react'

export type StampedState<T> = {
  /** The value, but only if it was stored under the current stamp. */
  value: T | null
  /** Stores a value under the current stamp, or clears it when given null. */
  set: (next: T | null) => void
}

export function useStampedState<T>(stamp: string | null): StampedState<T> {
  const [lastStamp, setLastStamp] = useState<string | null>(stamp)
  const [stored, setStored] = useState<{ stamp: string; value: T } | null>(null)

  if (lastStamp !== stamp) {
    setLastStamp(stamp)
    setStored(null)
  }

  const set = useCallback(
    (next: T | null): void => {
      if (stamp === null || next === null) {
        setStored(null)
        return
      }

      setStored({ stamp, value: next })
    },
    [stamp],
  )

  return {
    value: stored !== null && stamp !== null && stored.stamp === stamp ? stored.value : null,
    set,
  }
}
