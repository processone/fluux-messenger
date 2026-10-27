// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { RoomInfoModal } from './RoomInfoModal'
import type { Room } from '@fluux/sdk'

// Surface i18n keys verbatim so assertions target keys, not translated copy.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    jid: 'general@conference.example.com',
    name: 'General',
    subject: 'Welcome to the general room',
    ...overrides,
  } as Room
}

// Helper to force the topic element to report overflow in jsdom (which
// otherwise reports scrollHeight === clientHeight === 0).
function forceOverflow(scrollHeight: number, clientHeight: number) {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true, get() { return scrollHeight },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true, get() { return clientHeight },
  })
}

afterEach(() => {
  // Restore jsdom defaults so overflow overrides don't leak between tests.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
})

describe('RoomInfoModal', () => {
  // FLM-171 G1/G2: the window must expose the named dialog that positive
  // and negative interaction checks observe, not merely its visible contents.
  it.each(['General', ''])('exposes a named dialog and its close control (room name: %s)', name => {
    const room = makeRoom({ name })
    render(<RoomInfoModal room={room} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: room.name || room.jid })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(within(dialog).getByRole('heading', { level: 2 }).textContent).toBe(room.name)
    expect(within(dialog).getByRole('button', { name: 'common.close' })).toBeTruthy()
  })

  it('renders the room name (title), JID and full topic', () => {
    render(<RoomInfoModal room={makeRoom()} onClose={() => {}} />)
    expect(screen.getByText('General')).toBeTruthy()
    expect(screen.getByText('general@conference.example.com')).toBeTruthy()
    expect(screen.getByText('Welcome to the general room')).toBeTruthy()
    expect(screen.getByText('rooms.topic')).toBeTruthy()
  })

  it('omits the topic section when the room has no subject', () => {
    render(<RoomInfoModal room={makeRoom({ subject: undefined })} onClose={() => {}} />)
    expect(screen.queryByText('rooms.topic')).toBeNull()
    // Identity still renders.
    expect(screen.getByText('General')).toBeTruthy()
  })

  it('shows no Show more toggle when the topic fits', () => {
    forceOverflow(50, 50)
    render(<RoomInfoModal room={makeRoom()} onClose={() => {}} />)
    expect(screen.queryByText('chat.showMore')).toBeNull()
    expect(screen.queryByText('chat.showLess')).toBeNull()
  })

  it('shows a Show more toggle when the topic overflows, and toggles to Show less', () => {
    forceOverflow(300, 120)
    render(<RoomInfoModal room={makeRoom({ subject: 'x'.repeat(2000) })} onClose={() => {}} />)
    const moreBtn = screen.getByText('chat.showMore')
    expect(moreBtn).toBeTruthy()
    fireEvent.click(moreBtn)
    expect(screen.getByText('chat.showLess')).toBeTruthy()
  })
})
