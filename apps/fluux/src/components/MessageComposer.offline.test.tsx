import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageComposer } from './MessageComposer'

// UX_REVIEW §4.2 — while the connection is degraded mid-session, the composer
// placeholder must say that messages will be queued, instead of pretending
// everything is normal. 'disconnected'/'error' are NOT covered: App routes
// those to LoginScreen, so the composer is unmounted.

let mockStatus = 'online'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: { status: string }) => unknown) =>
    selector({ status: mockStatus }),
}))

const renderComposer = () =>
  render(
    <MessageComposer
      placeholder="Message Emma Wilson"
      onSend={vi.fn().mockResolvedValue(true)}
    />
  )

describe('MessageComposer offline placeholder', () => {
  beforeEach(() => {
    mockStatus = 'online'
  })

  it('keeps the conversation placeholder while online', () => {
    renderComposer()
    expect(screen.getByPlaceholderText('Message Emma Wilson')).toBeTruthy()
  })

  it('announces queueing while reconnecting', () => {
    mockStatus = 'reconnecting'
    renderComposer()
    expect(screen.getByPlaceholderText('chat.offlinePlaceholder')).toBeTruthy()
  })

  it('announces queueing while a slow connect is in progress', () => {
    mockStatus = 'connecting'
    renderComposer()
    expect(screen.getByPlaceholderText('chat.offlinePlaceholder')).toBeTruthy()
  })

  it('keeps the normal placeholder on disconnected (composer is unmounted by App)', () => {
    mockStatus = 'disconnected'
    renderComposer()
    expect(screen.getByPlaceholderText('Message Emma Wilson')).toBeTruthy()
  })
})
