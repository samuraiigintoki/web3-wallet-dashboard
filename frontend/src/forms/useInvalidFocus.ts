import { useEffect, useRef } from 'react'

/**
 * Puts focus on the first invalid field after a submission is rejected.
 *
 * Without it, a rejected submit leaves the person where they were, with the
 * message they need sitting above the fold or below the button they just
 * pressed. The signature is the errors themselves, so focus moves when they
 * appear and not while someone is typing.
 */
export function useInvalidFocus(errors: readonly (string | null)[]) {
  const formRef = useRef<HTMLFormElement>(null)
  const signature = errors.map((error) => error ?? '').join(' | ')

  useEffect(() => {
    if (signature === '' || formRef.current === null) {
      return
    }

    const first = formRef.current.querySelector<HTMLElement>('[aria-invalid="true"]')
    first?.focus()
  }, [signature])

  return formRef
}
