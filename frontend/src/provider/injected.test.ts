import { describe, expect, it, vi } from 'vitest'

import {
  describeProviderFailure,
  parseAccountList,
  parseChainId,
  providerErrorCode,
  readInjectedProvider,
} from './injected.ts'

const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const OTHER = '0x2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E'

describe('reading the injected provider', () => {
  it('reports absence without throwing', () => {
    expect(readInjectedProvider(undefined)).toBeNull()
    expect(readInjectedProvider(null)).toBeNull()
    expect(readInjectedProvider({})).toBeNull()
    expect(readInjectedProvider({ ethereum: null })).toBeNull()
    expect(readInjectedProvider({ ethereum: 'injected' })).toBeNull()
  })

  it('needs a request method, and nothing else, to count as a provider', () => {
    expect(readInjectedProvider({ ethereum: {} })).toBeNull()
    expect(readInjectedProvider({ ethereum: { request: 'yes' } })).toBeNull()

    const provider = readInjectedProvider({ ethereum: { request: () => 1 } })

    expect(provider).not.toBeNull()
    // No listener API on the object, so none is offered.
    expect(provider?.subscribe).toBeNull()
    expect(provider?.unsubscribe).toBeNull()
  })

  it('offers listeners only when it can remove them again', () => {
    const bothPresent = readInjectedProvider({
      ethereum: { request: () => 1, on: () => undefined, removeListener: () => undefined },
    })

    expect(bothPresent?.subscribe).not.toBeNull()
    expect(bothPresent?.unsubscribe).not.toBeNull()

    // A subscription that could not be removed would outlive the screen.
    const noRemoval = readInjectedProvider({
      ethereum: { request: () => 1, on: () => undefined },
    })

    expect(noRemoval?.subscribe).toBeNull()
    expect(noRemoval?.unsubscribe).toBeNull()
  })

  it('calls the object as the provider, not as a copy', () => {
    const request = vi.fn(function (this: unknown) {
      return Promise.resolve(this)
    })

    const object = { request }
    const provider = readInjectedProvider({ ethereum: object })

    void provider?.request({ method: 'eth_accounts' })

    expect(request.mock.contexts[0]).toBe(object)
  })
})

describe('account lists', () => {
  it('accepts a list of addresses, and an empty one', () => {
    expect(parseAccountList([ACCOUNT])).toEqual([ACCOUNT])
    expect(parseAccountList([ACCOUNT, OTHER])).toEqual([ACCOUNT, OTHER])
    expect(parseAccountList([])).toEqual([])
  })

  it('refuses anything that is not a list of addresses, in full', () => {
    for (const value of [
      undefined,
      null,
      'injected',
      { 0: ACCOUNT },
      [42],
      [null],
      ['not-an-address'],
      [ACCOUNT, 42],
      [`${ACCOUNT} `],
      [ACCOUNT.slice(2)],
    ]) {
      expect(parseAccountList(value)).toBeNull()
    }
  })
})

describe('chain ids', () => {
  it('reads the hex quantities a provider sends', () => {
    expect(parseChainId('0x1')).toBe(1)
    expect(parseChainId('0x89')).toBe(137)
    expect(parseChainId('0xaa36a7')).toBe(11155111)
  })

  it('refuses anything else', () => {
    for (const value of [
      undefined,
      null,
      1,
      137,
      '1',
      '0X1',
      '0x',
      '0x0',
      '0xgg',
      ' 0x1',
      '0x1 ',
      '-0x1',
      '0x123456789abcde',
      'abc',
      '',
    ]) {
      expect(parseChainId(value)).toBeNull()
    }
  })
})

describe('provider failures', () => {
  it('reads the code, and nothing else, from an error', () => {
    expect(providerErrorCode({ code: 4001 })).toBe(4001)
    expect(providerErrorCode({ code: '4001' })).toBeNull()
    expect(providerErrorCode({ code: 1.5 })).toBeNull()
    expect(providerErrorCode(new Error('boom'))).toBeNull()
    expect(providerErrorCode('boom')).toBeNull()
    expect(providerErrorCode(null)).toBeNull()
  })

  it('never repeats the provider text, which is untrusted and internal', () => {
    const message = describeProviderFailure({
      code: -32603,
      message: 'MetaMask Tx Signature: internal state 0xdeadbeef leaked',
    })

    expect(message).toContain('-32603')
    expect(message).not.toContain('MetaMask')
    expect(message).not.toContain('0xdeadbeef')

    expect(describeProviderFailure({ code: 4001 })).toBe(
      'The request was declined in the wallet.',
    )
    expect(describeProviderFailure({ code: -32002 })).toContain('already has a request open')
    expect(describeProviderFailure('boom')).toBe('The wallet could not complete the request.')
  })
})
