import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'

import { describeApiError } from '../api/index.ts'
import { useAuth } from '../auth/useAuth.ts'
import { fieldErrorsFrom } from '../forms/serverErrors.ts'
import { useInvalidFocus } from '../forms/useInvalidFocus.ts'
import { validateEmail, validatePassword } from '../forms/validation.ts'
import { readLocationState } from '../routes/locationState.ts'
import { Button } from '../ui/Button.tsx'
import { Notice } from '../ui/Notice.tsx'
import { Page, PageForm } from '../ui/Page.tsx'
import { TextField } from '../ui/TextField.tsx'

export function LoginPage() {
  const { login, logoutProblem } = useAuth()
  const location = useLocation()
  const incoming = readLocationState(location.state)

  const [email, setEmail] = useState(incoming.email ?? '')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // Bumped on every rejected submit, so a second attempt with the same
  // values takes focus back to the field that has to change.
  const [attempt, setAttempt] = useState(0)

  const formRef = useInvalidFocus(attempt)

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
      setAttempt((count) => count + 1)
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
          setAttempt((count) => count + 1)
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
    <Page title="Sign in" narrow>
      {incoming.notice !== undefined && <Notice>{incoming.notice}</Notice>}

      {logoutProblem !== null && (
        <Notice>
          You were signed out on this device, but the session could not be ended on
          the server. {logoutProblem}
        </Notice>
      )}

      <PageForm ref={formRef} onSubmit={handleSubmit}>
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
          }}
          error={emailError}
        />

        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
          }}
          error={passwordError}
        />

        {formError !== null && <Notice urgency="alert">{formError}</Notice>}

        <Button type="submit" pending={pending}>
          Sign in
        </Button>
      </PageForm>

      <p>
        No account yet? <Link to="/register">Create one</Link>.
      </p>
    </Page>
  )
}
