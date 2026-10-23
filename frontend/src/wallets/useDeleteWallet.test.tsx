import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, type ApiClient, type Wallet } from '../api/index.ts'
import type { DataSession } from '../auth/session.ts'
import { useDeleteWallet } from './useDeleteWallet.ts'

/**
 * The hook on its own, without the row that renders it.
 *
 * The page blocks a settled row's action, but a guard that lives only in the
 * page can be walked around by any caller. These press the hook's own entry
 * point again after it has answered, which is what must never send a second
 * request once the record is settled.
 */

const WALLET: Wallet = {
  id: 11,
  address: '0x00000000000000000000000000000000000000c3',
  chainId: 11155111,
  label: 'Treasury',
  createdAt: '2026-10-18T09:00:00Z',
}

function session(client: Partial<ApiClient>): DataSession {
  const complete = {
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    getMe: vi.fn(),
    listWallets: vi.fn(),
    createWallet: vi.fn(),
    updateWalletLabel: vi.fn(),
    deleteWallet: vi.fn(async () => undefined),
    getWallet: vi.fn(async () => WALLET),
    ...client,
  } as unknown as ApiClient

  return { userId: 5, generation: 1, client: complete }
}

describe('removal attempt lifetime', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses a second send once the server confirmed the removal', async () => {
    const deleteWallet = vi.fn(async () => undefined)
    const dataSession = session({ deleteWallet })

    const { result } = renderHook(() => useDeleteWallet({ dataSession, walletId: 11 }))

    await act(async () => {
      await result.current.remove()
    })
    await waitFor(() => {
      expect(result.current.state.status).toBe('removed')
    })

    await act(async () => {
      await result.current.remove()
    })

    expect(deleteWallet).toHaveBeenCalledTimes(1)
    expect(result.current.state.status).toBe('removed')
  })

  it('refuses a second send once the server says it is unavailable', async () => {
    const deleteWallet = vi.fn(async () => {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        status: 404,
        message: 'wallet not found',
      })
    })
    const dataSession = session({ deleteWallet })

    const { result } = renderHook(() => useDeleteWallet({ dataSession, walletId: 11 }))

    await act(async () => {
      await result.current.remove()
    })
    await waitFor(() => {
      expect(result.current.state.status).toBe('unavailable')
    })

    await act(async () => {
      await result.current.remove()
    })

    expect(deleteWallet).toHaveBeenCalledTimes(1)
    expect(result.current.state.status).toBe('unavailable')
  })

  it('lets an unconfirmed attempt be sent again, because nothing was settled', async () => {
    const deleteWallet = vi.fn(async () => {
      throw new ApiError({ code: 'TIMEOUT', status: 0, message: 'the request timed out' })
    })
    const dataSession = session({ deleteWallet })

    const { result } = renderHook(() => useDeleteWallet({ dataSession, walletId: 11 }))

    await act(async () => {
      await result.current.remove()
    })
    await waitFor(() => {
      expect(result.current.state.status).toBe('unconfirmed')
    })

    await act(async () => {
      await result.current.remove()
    })

    expect(deleteWallet).toHaveBeenCalledTimes(2)
  })

  it('lets a rejected attempt be sent again', async () => {
    const deleteWallet = vi.fn(async () => {
      throw new ApiError({ code: 'RATE_LIMITED', status: 429, message: 'too many requests' })
    })
    const dataSession = session({ deleteWallet })

    const { result } = renderHook(() => useDeleteWallet({ dataSession, walletId: 11 }))

    await act(async () => {
      await result.current.remove()
    })
    await waitFor(() => {
      expect(result.current.state.status).toBe('failed')
    })

    await act(async () => {
      await result.current.remove()
    })

    expect(deleteWallet).toHaveBeenCalledTimes(2)
  })

  it('still allows the read-only check after a settled answer, and never deletes again', async () => {
    const deleteWallet = vi.fn(async () => undefined)
    const getWallet = vi.fn(async () => WALLET)
    const dataSession = session({ deleteWallet, getWallet })

    const { result } = renderHook(() => useDeleteWallet({ dataSession, walletId: 11 }))

    await act(async () => {
      await result.current.remove()
    })

    await act(async () => {
      await result.current.verify()
    })

    await waitFor(() => {
      expect(result.current.check.status).toBe('present')
    })

    expect(getWallet).toHaveBeenCalledTimes(1)
    expect(getWallet).toHaveBeenCalledWith(11, expect.anything())
    expect(deleteWallet).toHaveBeenCalledTimes(1)
  })
})
