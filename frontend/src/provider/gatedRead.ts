import { useState } from 'react'

/**
 * How many times a read gate has opened.
 *
 * A gate is the app's permission to ask for something: a connected account on a
 * chain this deployment can act on, with the catalog that says so already
 * answered. When a gate closes and later reopens for the same account and chain,
 * that is a new permission rather than the old one resumed, and anything read
 * before the closure describes a moment the app has since lost sight of.
 *
 * Counting the openings is what puts the closure into a read's stamp, so an
 * older answer can never match a current stamp again. It lives here, in one
 * place, because it is the rule that keeps every gated read honest, and two
 * slightly different versions of it would be one bug waiting to happen.
 *
 * The transition is noticed during render rather than in an effect: the stamp is
 * built during render, and one frame of the old stamp is one frame of an old
 * value on screen.
 */
export function useGateOpening(enabled: boolean): number {
  const [opening, setOpening] = useState(0)
  const [wasOpen, setWasOpen] = useState(enabled)

  if (wasOpen !== enabled) {
    setWasOpen(enabled)

    if (enabled) {
      setOpening((current) => current + 1)
    }
  }

  return opening
}
