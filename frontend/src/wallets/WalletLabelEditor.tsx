import { useEffect, useId, useRef, useState, type FormEvent } from 'react'

import { describeApiError, type ApiError, type Wallet } from '../api/index.ts'
import type { DataSession } from '../auth/session.ts'
import type { IdentityRef } from '../data/identityKeys.ts'
import { useUpdateWalletLabel } from './useUpdateWalletLabel.ts'
import { isUnconfirmedWrite } from './writeOutcome.ts'
import { normalizeLabel, validateLabel } from './validate.ts'

/**
 * The label editor for one saved row.
 *
 * Inline rather than a modal or a route: the row it changes is already on
 * screen, and a dialog over a table would have to re-create the address and
 * chain it is not editing. One editor is open at a time, which is the page's
 * decision, and this component assumes it is the only one mounted.
 */

const UNAVAILABLE_MESSAGE =
  'That wallet is no longer in your list. Nothing was changed by this save.'

/**
 * Used for a save whose fate is unknown: a timeout, a dropped connection, a
 * success this client could not verify, or a gateway that lost the answer.
 *
 * The row may already hold the new label, so the honest advice is to look at the
 * list. There is no automatic retry and no claim that the change was undone.
 */
const UNCONFIRMED_MESSAGE =
  'The label change did not finish, so it may or may not have been saved. Check the list below before trying again.'

type WalletLabelEditorProps = {
  dataSession: DataSession
  wallet: Wallet
  /** Refreshes that identity's list pages, keeping the current page. */
  onUpdated: (identity: IdentityRef, wallet: Wallet) => void
  /** Closes the editor without writing anything. Disabled while submitting. */
  onCancel: () => void
  /**
   * Reads the list again and returns the row the server answered with.
   *
   * A read-only reconciliation is only useful if its result is visible, so this
   * resolves to the refreshed row rather than to nothing.
   */
  onReadBack: (walletId: number) => Promise<Wallet | null>
}

export function WalletLabelEditor({
  dataSession,
  wallet,
  onUpdated,
  onCancel,
  onReadBack,
}: WalletLabelEditorProps) {
  const labelId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  /** The draft. Nothing refreshes it, so a list read cannot overwrite typing. */
  const [label, setLabel] = useState(wallet.label)
  const [clientError, setClientError] = useState<string | null>(null)

  const { state, submit, reset } = useUpdateWalletLabel({
    dataSession,
    walletId: wallet.id,
    onUpdated,
  })

  /**
   * What the last manual read of the list showed for this row.
   *
   * Kept beside the draft rather than in place of it: the draft is the user's
   * typing and a read must not overwrite it, while this is what the server
   * actually holds. Together they are the only honest answer to "did my change
   * land?".
   */
  const [readBack, setReadBack] = useState<
    | { status: 'idle' }
    | { status: 'reading' }
    | { status: 'found'; label: string }
    | { status: 'unreadable' }
  >({ status: 'idle' })

  const submitting = state.status === 'submitting'

  /**
   * Focus on entry.
   *
   * The editor replaces a table cell, so without this the caret would be left
   * nowhere near the input the user just asked for. It runs on mount only: an
   * effect on every state change would pull the caret back while the user is
   * typing.
   */
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /**
   * The field error.
   *
   * A `422` puts its message under the input it names. A client rejection is
   * the same message for a value the server was never asked about, and a
   * previous rejection is dropped the moment a new attempt starts, so an old
   * message can never describe the value on screen.
   */
  /**
   * Focus after a rejected submission.
   *
   * A client rejection focuses the input directly, because no render is needed
   * to know the value was refused. A server rejection arrives as a state
   * change, so it is caught here. Every path that leaves the user with an
   * invalid value puts them back in the field that has to change.
   */
  useEffect(() => {
    if (state.status === 'failed') {
      inputRef.current?.focus()
    }
  }, [state])

  const serverErrors = state.status === 'failed' ? state.fieldErrors : {}
  const error = serverErrors.label ?? clientError

  /**
   * The form-level message, shown only when there is no field error to carry
   * the failure: a `404`, a rate limit, a service failure or an unconfirmed
   * outcome.
   */
  const failure = state.status === 'failed' ? state.error : null
  const formMessage =
    failure !== null && serverErrors.label === undefined
      ? failureMessage(failure)
      : null

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    // A second submit, including one from a double click, is refused here as
    // well as in the hook.
    if (submitting) {
      return
    }

    // Every attempt answers for itself. The previous attempt's server errors
    // and its reconciliation result are retired before this one is judged, so a
    // stale `422` cannot sit beside the client message this attempt found, and a
    // stale readback cannot describe a value the user has already changed.
    if (state.status === 'failed') {
      reset()
    }

    setReadBack({ status: 'idle' })

    const nextError = validateLabel(label)

    if (nextError !== null) {
      setClientError(nextError)
      inputRef.current?.focus()
      return
    }

    setClientError(null)

    void submit({ walletId: wallet.id, label: normalizeLabel(label) })
  }

  const handleReadBack = (): void => {
    setReadBack({ status: 'reading' })

    onReadBack(wallet.id).then(
      (row) => {
        // A null row means the refreshed page no longer holds this wallet. The
        // page retires the selection at that point and this editor unmounts, so
        // there is no message to show here and nothing to keep alive for it.
        setReadBack(row === null ? { status: 'idle' } : { status: 'found', label: row.label })
      },
      () => {
        setReadBack({ status: 'unreadable' })
      },
    )
  }

  return (
    <form
      className="form"
      onSubmit={handleSubmit}
      noValidate
      aria-busy={submitting}
      // Named for the row it edits, because the create form above it has its
      // own field called Label and two inputs with the same name would be
      // ambiguous to anyone navigating by name.
      aria-label={`Edit label for ${wallet.address}`}
    >
      <div className="field">
        <label htmlFor={labelId}>Label</label>
        <input
          id={labelId}
          name="label"
          type="text"
          autoComplete="off"
          ref={inputRef}
          value={label}
          onChange={(event) => {
            setLabel(event.target.value)
          }}
          aria-invalid={error !== null}
        />
        {error !== null && (
          <span className="field__error" role="alert">
            {error}
          </span>
        )}
      </div>

      <div className="status__actions">
        {/* Constant labels. A button that renames itself mid-click makes a
            double submit harder to reason about, and the form already carries
            aria-busy. */}
        <button type="submit" disabled={submitting}>
          Save label
        </button>
        {/* Disabled while a save is in flight: closing the editor then would
            leave a request on the wire whose answer nobody is watching, and an
            abort would be an unconfirmed change with no way to report it. */}
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>

      {formMessage !== null && (
        <div className="notice" role="alert">
          <p>{formMessage}</p>
          {failure !== null && isUnconfirmedWrite(failure) && (
            <div className="status__actions">
              <button
                type="button"
                onClick={handleReadBack}
                disabled={readBack.status === 'reading'}
              >
                Check the list
              </button>
            </div>
          )}
        </div>
      )}

      {/* The result of a read, in its own live region so it is announced. It
          states what the list holds without touching the draft, and it names the
          row's stored label so the user can compare it with what they typed. */}
      {readBack.status === 'found' && (
        <p className="notice" role="status">
          {`The list now shows this wallet labelled "${readBack.label}".`}
        </p>
      )}

      {readBack.status === 'unreadable' && (
        <p className="notice" role="status">
          The list could not be read. Try again.
        </p>
      )}

      {readBack.status === 'reading' && <p role="status">Reading the list.</p>}
    </form>
  )
}

/**
 * What went wrong, in the words the failure deserves.
 *
 * A `404` is separated from every other failure because it is not a failure of
 * the save as such: the row is gone. The API sends the same bytes for a foreign
 * id as for a missing one, so this message says exactly that much and never
 * guesses which it was. It is never a sign-out.
 */
function failureMessage(error: ApiError): string {
  if (error.code === 'RESOURCE_NOT_FOUND' || error.status === 404) {
    return UNAVAILABLE_MESSAGE
  }

  if (isUnconfirmedWrite(error)) {
    return UNCONFIRMED_MESSAGE
  }

  // Everything else keeps the API's own wording and the retry delay a rate
  // limit sent, because those are answers rather than unknowns.
  return describeApiError(error)
}
