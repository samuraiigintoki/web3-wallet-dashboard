import { useEffect, useRef } from 'react'

/**
 * Puts focus on the first invalid field after a rejected submission.
 *
 * Without it, a rejected submit leaves the person where they were, with the
 * message they need sitting above the fold or below the button they just
 * pressed. The trigger is the attempt itself and not the message: submitting
 * the same invalid values twice is two rejections, and the second one has to
 * take focus back from wherever the person wandered to.
 */
export function useInvalidFocus(attempt: number) {
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (attempt === 0 || formRef.current === null) {
      return
    }

    const first = formRef.current.querySelector<HTMLElement>('[aria-invalid="true"]')
    first?.focus()
  }, [attempt])

  return formRef
}
