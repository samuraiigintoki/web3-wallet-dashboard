import { useId, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'

import { describeApiError } from '../api/index.ts'
import { useAuth } from '../auth/useAuth.ts'
import { fieldErrorsFrom } from '../forms/serverErrors.ts'
import {
  MAX_PASSWORD_BYTES,
  validateEmail,
  validatePassword,
  validatePasswordConfirmation,
} from '../forms/validation.ts'

export function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()

  const emailId = useId()
  const passwordId = useId()
  const confirmationId = useId()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmationError, setConfirmationError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    if (pending) {
      return
    }

    const nextEmailError = validateEmail(email)
    const nextPasswordError = validatePassword(password)
    const nextConfirmationError = validatePasswordConfirmation(password, confirmation)
    setEmailError(nextEmailError)
    setPasswordError(nextPasswordError)
    setConfirmationError(nextConfirmationError)
    setFormError(null)

    if (
      nextEmailError !== null ||
      nextPasswordError !== null ||
      nextConfirmationError !== null
    ) {
      return
    }

    setPending(true)

    const run = async (): Promise<void> => {
      try {
        // The confirmation never leaves this component. The server decodes
        // with unknown fields disallowed, so sending it would be a 400, and
        // it is a typing aid rather than part of the contract.
        const user = await register({ email: email.trim(), password })

        // No auto-login. Register issues no token, so signing in here would
        // be a second rate-limited credential request that can fail on its
        // own and leave a created account with no session.
        await navigate('/login', {
          replace: true,
          state: {
            notice: 'Your account is ready. Sign in to continue.',
            email: user.email,
          },
        })
      } catch (error) {
        const fieldErrors = fieldErrorsFrom(error)
        if (fieldErrors.email !== undefined || fieldErrors.password !== undefined) {
          setEmailError(fieldErrors.email ?? null)
          setPasswordError(fieldErrors.password ?? null)
          return
        }
        setFormError(describeApiError(error))
      } finally {
        setPending(false)
      }
    }

    void run()
  }

  return (
    <main className="page page--narrow">
      <h1>Create an account</h1>

      <form className="form" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor={emailId}>Email</label>
          <input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
            }}
            aria-invalid={emailError !== null}
          />
          {emailError !== null && (
            <span className="field__error" role="alert">
              {emailError}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor={passwordId}>Password</label>
          <input
            id={passwordId}
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
            }}
            aria-invalid={passwordError !== null}
          />
          <span className="field__error">
            Up to {MAX_PASSWORD_BYTES} bytes. There is no password reset, so keep it
            somewhere safe.
          </span>
          {passwordError !== null && (
            <span className="field__error" role="alert">
              {passwordError}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor={confirmationId}>Confirm password</label>
          <input
            id={confirmationId}
            name="confirmation"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.target.value)
            }}
            aria-invalid={confirmationError !== null}
          />
          {confirmationError !== null && (
            <span className="field__error" role="alert">
              {confirmationError}
            </span>
          )}
        </div>

        {formError !== null && <p role="alert">{formError}</p>}

        <button type="submit" disabled={pending}>
          {pending ? 'Creating account' : 'Create account'}
        </button>
      </form>

      <p>
        Already have an account? <Link to="/login">Sign in</Link>.
      </p>
    </main>
  )
}
