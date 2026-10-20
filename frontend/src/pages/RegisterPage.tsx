import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'

import { describeApiError } from '../api/index.ts'
import { useAuth } from '../auth/useAuth.ts'
import { fieldErrorsFrom } from '../forms/serverErrors.ts'
import { useInvalidFocus } from '../forms/useInvalidFocus.ts'
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_RUNES,
  validateEmail,
  validateNewPassword,
  validatePasswordConfirmation,
} from '../forms/validation.ts'
import styles from '../ui/AuthComposition.module.css'
import { AuthComposition } from '../ui/AuthComposition.tsx'
import { Button } from '../ui/Button.tsx'
import { Notice } from '../ui/Notice.tsx'
import { PageForm } from '../ui/Page.tsx'
import { TextField } from '../ui/TextField.tsx'

const PASSWORD_HINT = `At least ${String(MIN_PASSWORD_RUNES)} characters and up to ${String(
  MAX_PASSWORD_BYTES,
)} bytes. There is no password reset, so keep it somewhere safe.`

export function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmationError, setConfirmationError] = useState<string | null>(null)
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
    const nextPasswordError = validateNewPassword(password)
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
      setAttempt((count) => count + 1)
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
    <AuthComposition title="Create an account" headline="Create an account to read the record.">
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
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
          }}
          hint={PASSWORD_HINT}
          error={passwordError}
        />

        <TextField
          label="Confirm password"
          name="confirmation"
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => {
            setConfirmation(event.target.value)
          }}
          error={confirmationError}
        />

        {formError !== null && <Notice urgency="alert">{formError}</Notice>}

        <Button type="submit" pending={pending}>
          Create account
        </Button>
      </PageForm>

      <p className={styles.footnote}>
        Already have an account? <Link to="/login">Sign in</Link>.
      </p>
    </AuthComposition>
  )
}
