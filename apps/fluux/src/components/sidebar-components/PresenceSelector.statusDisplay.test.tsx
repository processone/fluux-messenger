import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusDisplay } from './PresenceSelector'

// The ConnectionBanner is the single connection-incident surface (countdown,
// attempt number, cancel action). The user-menu chip must NOT duplicate it:
// while degraded it shows a static, muted "Offline" presence line — no
// spinner, no countdown.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}|${JSON.stringify(opts)}` : key,
  }),
}))

describe('StatusDisplay (user-menu chip)', () => {
  it.each(['reconnecting', 'connecting', 'verifying'])(
    'shows a static offline line during %s — the banner owns the details',
    (status) => {
      const { container } = render(<StatusDisplay status={status} />)

      expect(screen.getByText('presence.offline')).toBeTruthy()
      // No spinner, no countdown — nothing animated competing with the banner
      expect(container.querySelector('.animate-spin')).toBeNull()
      expect(container.textContent).not.toContain('status.reconnecting')
    }
  )

  it('still reports a terminal connection error', () => {
    render(<StatusDisplay status="error" />)
    expect(screen.getByText('status.connectionError')).toBeTruthy()
  })

  it('still reports disconnected', () => {
    render(<StatusDisplay status="disconnected" />)
    expect(screen.getByText('status.disconnected')).toBeTruthy()
  })
})
