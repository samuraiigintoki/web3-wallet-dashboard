import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'

import { describeApiError, type Chain } from '../api/index.ts'
import type { DataSession } from '../auth/session.ts'
import type { IdentityRef } from '../data/identityKeys.ts'
import type { WalletFormField } from '../forms/serverErrors.ts'
import { chainCatalogQuery } from './chainQueries.ts'
import {
  isUnconfirmedWrite,
  useCreateWallet,
  type CreateWalletFailure,
} from './useCreateWallet.ts'
import {
  WALLET_FIELD_ORDER,
  chainOptionLabel,
  normalizeAddress,
  normalizeLabel,
  validateAddress,
  validateChainId,
  validateLabel,
} from './validate.ts'

/**
 * A duplicate is its own sentence.
 *
 * The generic conflict line talks about reloading, which is the wrong advice
 * here: nothing is out of date, this account already has this address on this
 * chain, and the list above already shows it.
 */
const DUPLICATE_MESSAGE = 'That address is already saved on this chain.'

/**
 * Used when the outcome of the save is genuinely unknown.
 *
 * A timeout or a dropped connection reached no verdict, so the row may or may
 * not exist. Saying it failed would invite a second submit that turns into the
 * duplicate this message exists to prevent, and saying it succeeded would be a
 * guess. The user is told to look at the list, which is the only thing that
 * knows.
 */
const UNKNOWN_OUTCOME_MESSAGE =
  'The save did not finish, so it may or may not have been saved. Check the list above before trying again.'

/**
 * Used when the server answered, but the answer could not be verified.
 *
 * The three shapes this covers, malformed JSON on a 201, an empty 201 and a 201
 * without `createdAt`, all mean the same thing: the status says something was
 * accepted, and this client has no row it can trust. The write may already be
 * committed, so the honest advice is to look at the list before sending another
 * one, and there is no automatic retry and no claim that it was rolled back.
 */
const UNCONFIRMED_RESPONSE_MESSAGE =
  'The server answered, but not in a way this app could confirm, so the wallet may already be saved. Check the list above before saving again.'

function formMessage(failure: CreateWalletFailure): string {
  const { error, fieldErrors } = failure

  // A 422 puts its message under the input it names. Repeating it at the top
  // as well would give the user the same sentence twice.
  if (Object.keys(fieldErrors).length > 0) {
    return 'Check the highlighted fields.'
  }

  if (error.code === 'RESOURCE_CONFLICT') {
    return DUPLICATE_MESSAGE
  }

  if (isUnconfirmedWrite(error)) {
    return error.code === 'UNEXPECTED_RESPONSE'
      ? UNCONFIRMED_RESPONSE_MESSAGE
      : UNKNOWN_OUTCOME_MESSAGE
  }

  return describeApiError(error)
}

type WalletCreateFormProps = {
  /** Non-null: this form only renders for a validated identity. */
  dataSession: DataSession
  /** Refreshes that identity's list pages and returns the URL to page 1. */
  onSaved: (identity: IdentityRef) => void
  /**
   * Reads the list again without writing anything.
   *
   * Offered for a save whose outcome could not be confirmed: the only thing that
   * can say whether the row exists is the server's own list, and this is the
   * control that asks it.
   */
  onCheckList: () => void
}

export function WalletCreateForm({
  dataSession,
  onSaved,
  onCheckList,
}: WalletCreateFormProps) {
  const addressId = useId()
  const chainIdId = useId()
  const labelId = useId()

  const catalog = useQuery(chainCatalogQuery())
  const chains: readonly Chain[] = catalog.data ?? []

  const [address, setAddress] = useState('')
  const [chainId, setChainId] = useState<number | null>(null)
  const [label, setLabel] = useState('')
  const [clientErrors, setClientErrors] = useState<
    Partial<Record<WalletFormField, string>>
  >({})

  const addressRef = useRef<HTMLInputElement>(null)
  const chainRef = useRef<HTMLSelectElement>(null)
  const labelRef = useRef<HTMLInputElement>(null)

  const { state, submit, reset } = useCreateWallet({ dataSession, onSaved })

  /**
   * The identity this form belongs to.
   *
   * Every value the user has typed, and every message it owns, is retired when
   * this changes. That includes a credential replacement for the same user: the
   * draft belongs to the session that typed it, not to the account.
   */
  const identity = `${String(dataSession.userId)}:${String(dataSession.generation)}`

  useEffect(() => {
    setAddress('')
    setChainId(null)
    setLabel('')
    setClientErrors({})
  }, [identity])

  // A confirmed save clears what was typed and keeps the chain, which is the
  // one choice likely to be wanted again. The success message stays until
  // another submit replaces it.
  useEffect(() => {
    if (state.status === 'saved') {
      setAddress('')
      setLabel('')
      setClientErrors({})
    }
  }, [state])

  // A rejected submission puts focus on the first field the server or the
  // client flagged, so the user does not have to hunt for it.
  useEffect(() => {
    if (state.status !== 'failed') {
      return
    }

    const first = WALLET_FIELD_ORDER.find(
      (field) => state.fieldErrors[field] !== undefined,
    )

    if (first !== undefined) {
      focusField(first)
    }
  }, [state])

  function focusField(field: WalletFormField): void {
    const node =
      field === 'address'
        ? addressRef.current
        : field === 'chainId'
          ? chainRef.current
          : labelRef.current

    node?.focus()
  }

  const submitting = state.status === 'submitting'
  const serverErrors: Partial<Record<WalletFormField, string>> =
    state.status === 'failed' ? state.fieldErrors : {}
  const errors: Partial<Record<WalletFormField, string>> =
    Object.keys(serverErrors).length > 0 ? serverErrors : clientErrors

  // No catalog, or a catalog with nothing in it, means there is no valid
  // selection to make. The button is disabled rather than left to fail on
  // submit, because a form cannot be filled in correctly with no options.
  const catalogUnusable = catalog.error !== null || chains.length === 0

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    if (submitting) {
      return
    }

    // Every attempt answers for itself. The previous attempt's server errors are
    // retired before this one is judged, or a stale chain error would sit on a
    // field the user has already corrected and override the label error this
    // attempt found, including on an attempt that sends no POST at all.
    if (state.status === 'failed') {
      reset()
    }

    const nextErrors: Partial<Record<WalletFormField, string>> = {}
    const addressError = validateAddress(address)
    const chainError = validateChainId(chainId, chains)
    const labelError = validateLabel(label)

    if (addressError !== null) {
      nextErrors.address = addressError
    }
    if (chainError !== null) {
      nextErrors.chainId = chainError
    }
    if (labelError !== null) {
      nextErrors.label = labelError
    }

    setClientErrors(nextErrors)

    const firstInvalid = WALLET_FIELD_ORDER.find(
      (field) => nextErrors[field] !== undefined,
    )

    if (firstInvalid !== undefined) {
      focusField(firstInvalid)
      return
    }

    // Sent in the same shape the server stores it, so the duplicate lookup and
    // the saved row agree with what was typed.
    void submit({
      address: normalizeAddress(address),
      chainId: chainId ?? 0,
      label: normalizeLabel(label),
    })
  }

  return (
    <section aria-labelledby="wallet-create-heading">
      <h2 id="wallet-create-heading">Add a wallet</h2>

      {catalog.isPending && <p role="status">Loading chains.</p>}

      {catalog.error !== null && (
        <div className="status" role="alert">
          {/* A failed catalog is a real failure with its own Retry. It is not a
              create failure, and it is never a session problem. */}
          <p>{describeApiError(catalog.error)}</p>
          <div className="status__actions">
            <button
              type="button"
              onClick={() => void catalog.refetch()}
              disabled={catalog.isFetching}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {catalog.error === null && !catalog.isPending && chains.length === 0 && (
        <p role="status">
          No chains are available in this deployment, so no wallet can be saved
          yet.
        </p>
      )}

      <form className="form" onSubmit={handleSubmit} noValidate aria-busy={submitting}>
        <div className="field">
          <label htmlFor={addressId}>Address</label>
          <input
            id={addressId}
            name="address"
            type="text"
            autoComplete="off"
            spellCheck={false}
            ref={addressRef}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value)
            }}
            aria-invalid={errors.address !== undefined}
          />
          {errors.address !== undefined && (
            <span className="field__error" role="alert">
              {errors.address}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor={chainIdId}>Chain</label>
          <select
            id={chainIdId}
            name="chainId"
            ref={chainRef}
            value={chainId === null ? '' : String(chainId)}
            onChange={(event) => {
              const raw = event.target.value
              setChainId(raw === '' ? null : Number.parseInt(raw, 10))
            }}
            disabled={catalog.isPending || chains.length === 0}
            aria-invalid={errors.chainId !== undefined}
          >
            <option value="">
              {catalog.isPending ? 'Loading chains.' : 'Select a chain'}
            </option>
            {chains.map((chain) => (
              <option key={chain.chainId} value={String(chain.chainId)}>
                {chainOptionLabel(chain)}
              </option>
            ))}
          </select>
          {errors.chainId !== undefined && (
            <span className="field__error" role="alert">
              {errors.chainId}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor={labelId}>Label</label>
          <input
            id={labelId}
            name="label"
            type="text"
            autoComplete="off"
            ref={labelRef}
            value={label}
            onChange={(event) => {
              setLabel(event.target.value)
            }}
            aria-invalid={errors.label !== undefined}
          />
          {errors.label !== undefined && (
            <span className="field__error" role="alert">
              {errors.label}
            </span>
          )}
        </div>

        {/* The label is constant. A button that renames itself while the user
            is looking at it makes a double click harder to reason about, not
            easier, and the form already carries aria-busy. */}
        <button type="submit" disabled={submitting || catalogUnusable}>
          Save wallet
        </button>

        {state.status === 'saved' && (
          <p className="notice" role="status">
            {`Saved ${state.wallet.label}.`}
          </p>
        )}

        {state.status === 'failed' && (
          <div className="notice" role="alert">
            <p>{formMessage(state)}</p>
            {isUnconfirmedWrite(state.error) && (
              <div className="status__actions">
                <button type="button" onClick={onCheckList}>
                  Check the list
                </button>
              </div>
            )}
          </div>
        )}
      </form>
    </section>
  )
}
