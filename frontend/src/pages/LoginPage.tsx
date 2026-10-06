import { useId, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'

import { describeApiError } from '../api/index.ts'
import { useAuth } from '../auth/useAuth.ts'
import { fieldErrorsFrom } from '../forms/serverErrors.ts'
import { validateEmail, validatePassword } from '../forms/validation.ts'
import { readLocationState } from '../routes/locationState.ts'

export function LoginPage() {
  const { login, logoutProblem } = useAuth()
  const location = useLocation()
  const incoming = readLocationState(location.state)

  const emailId = useId()
  const passwordId = useId()

  const [email, setEmail] = useState(incoming.email ?? '')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    if (pending) {
      return
    }

    const nextEmailError = validateEmail(email)
    const nextPasswordError = validatePassword(password)
    setEmailError(nextEmailError)
    setPasswordError(nextPasswordError)
    setFormError(null)

    if (nextEmailError !== null || nextPasswordError !== null) {
      return
    }

    setPending(true)

    const run = async (): Promise<void> => {
      try {
        // The password is sent exactly as typed. Trimming it here would lock
        // out anyone whose password legitimately has an edge space.
        await login({ email: email.trim(), password })
        // No navigate here. GuestOnly owns the redirect once the session is
        // authenticated, including the return path carried in router state.
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
      <h1>Sign in</h1>

      {incoming.notice !== undefined && (
        <p className="notice" role="status">
          {incoming.notice}
        </p>
      )}

      {logoutProblem !== null && (
        <p className="notice" role="status">
          You were signed out on this device, but the server could not be reached to
          end the session. {logoutProblem}
        </p>
      )}

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
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
            }}
            aria-invalid={passwordError !== null}
          />
          {passwordError !== null && (
            <span className="field__error" role="alert">
              {passwordError}
            </span>
          )}
        </div>

        {formError !== null && <p role="alert">{formError}</p>}

        <button type="submit" disabled={pending}>
          {pending ? 'Signing in' : 'Sign in'}
        </button>
      </form>

      <p>
        No account yet? <Link to="/register">Create one</Link>.
      </p>
    </main>
  )
}
