import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { SDKEvents } from '@fluux/sdk'

type Handler = (payload: SDKEvents['storage:outdated']) => void
const handlers = new Set<Handler>()
const client = {
  subscribe: vi.fn((event: string, handler: Handler) => {
    if (event === 'storage:outdated') handlers.add(handler)
    return () => { handlers.delete(handler) }
  }),
}

vi.mock('@fluux/sdk', () => ({
  useXMPP: () => ({ client }),
}))

const { StorageOutdatedBanner } = await import('./StorageOutdatedBanner')

function emitOutdated(database = 'fluux-message-cache') {
  act(() => { for (const handler of handlers) handler({ database }) })
}

describe('StorageOutdatedBanner', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('stays hidden until a newer client upgrades local storage', () => {
    render(<StorageOutdatedBanner />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    emitOutdated()

    expect(screen.getByRole('status')).toHaveTextContent('storageOutdated.title')
  })

  it('reloads the page from its action', () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    render(<StorageOutdatedBanner />)
    emitOutdated()

    fireEvent.click(screen.getByRole('button', { name: 'storageOutdated.reload' }))

    expect(reload).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it('can be dismissed and does not come back for another database', () => {
    render(<StorageOutdatedBanner />)
    emitOutdated()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    emitOutdated('fluux-search-index')

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('unsubscribes when unmounted', () => {
    const { unmount } = render(<StorageOutdatedBanner />)
    unmount()
    expect(handlers.size).toBe(0)
  })
})
