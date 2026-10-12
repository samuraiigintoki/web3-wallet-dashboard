import type { ButtonHTMLAttributes, ReactNode } from 'react'

import styles from './Button.module.css'
import { Spinner } from './Spinner.tsx'

type Props = {
  variant?: 'primary' | 'secondary'
  /** True while the request this button starts is in flight. */
  pending?: boolean
  children: ReactNode
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>

/**
 * A button.
 *
 * While pending the label stays exactly as it was and the control is disabled,
 * because the accessible name is what a person searches for, and a name that
 * changes mid action makes the button disappear under them. The state is
 * carried by aria-busy and by the spinner beside the label.
 */
export function Button({
  variant = 'primary',
  pending = false,
  className,
  disabled,
  type = 'button',
  children,
  ...rest
}: Props) {
  const variantClass = variant === 'secondary' ? styles.secondary : styles.primary
  const classes = [styles.button, variantClass, className].filter(Boolean).join(' ')

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      aria-busy={pending}
      disabled={pending || disabled === true}
    >
      {children}
      {pending && <Spinner />}
    </button>
  )
}
