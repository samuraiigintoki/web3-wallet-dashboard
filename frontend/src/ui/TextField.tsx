import { useId, type InputHTMLAttributes, type Ref } from 'react'

import styles from './TextField.module.css'

type Props = {
  label: string
  /** Help that is always true of the field, read before the error. */
  hint?: string
  /** What is wrong with the value, in words. */
  error?: string | null
  ref?: Ref<HTMLInputElement>
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'aria-invalid' | 'aria-describedby'>

/**
 * A text field with its label, hint and error bound to the control.
 *
 * The error is announced politely rather than as an alert: it appears next to
 * the field the person is already in, and interrupting them mid form to say
 * what they just typed is wrong is not the same as telling them the submission
 * failed. The value is never rewritten here, so a password with an edge space
 * arrives at the server exactly as typed.
 */
export function TextField({ label, hint, error, ref, type, ...rest }: Props) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const invalid = error !== null && error !== undefined

  const describedBy = [hint === undefined ? null : hintId, invalid ? errorId : null]
    .filter((one) => one !== null)
    .join(' ')

  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>

      <input
        {...rest}
        ref={ref}
        id={id}
        type={type}
        className={styles.control}
        aria-invalid={invalid}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        // An email address is a value, not prose. Suggestions in it are noise,
        // and on some platforms they rewrite it.
        spellCheck={type === 'email' ? false : rest.spellCheck}
      />

      {hint !== undefined && (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      )}

      {invalid && (
        <span id={errorId} className={styles.error} role="status">
          {error}
        </span>
      )}
    </div>
  )
}
