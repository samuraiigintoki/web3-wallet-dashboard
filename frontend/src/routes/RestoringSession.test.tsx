import { render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RestoringSession, WAKE_NOTICE_DELAY_MS } from './RestoringSession.tsx'

const WAKE_NOTICE = /had stopped while nobody was using it/

describe('restoring session', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('says only that the session is being restored while that is still quick', () => {
    render(<RestoringSession />)

    expect(screen.getByRole('status').textContent).toBe('Restoring your session.')
    expect(screen.queryByText(WAKE_NOTICE)).toBeNull()
  })

  it('explains a long wait as the API starting, without losing the first sentence', () => {
    vi.useFakeTimers()
    render(<RestoringSession />)

    act(() => {
      vi.advanceTimersByTime(WAKE_NOTICE_DELAY_MS)
    })

    expect(screen.getByRole('status').textContent).toBe('Restoring your session.')
    expect(screen.getByText(WAKE_NOTICE)).toBeDefined()
    expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('true')
  })

  it('does not speak after the page has gone', () => {
    vi.useFakeTimers()
    const { unmount } = render(<RestoringSession />)

    unmount()

    expect(() => {
      act(() => {
        vi.advanceTimersByTime(WAKE_NOTICE_DELAY_MS)
      })
    }).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
