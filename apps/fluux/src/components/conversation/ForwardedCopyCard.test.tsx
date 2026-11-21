import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForwardedCopy } from '@fluux/sdk'
import { ForwardedCopyCard } from './ForwardedCopyCard'

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  route: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  rooms: new Map<string, { name: string }>(),
  contacts: new Map<string, { name: string }>(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@fluux/sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  findForwardedOrigin: mocks.find,
  connectionStore: { getState: () => ({ jid: 'me@example.org/desktop' }) },
  chatStore: { getState: () => ({ conversations: new Map([['bob@example.org', {}]]) }) },
}))
vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: (select: (s: unknown) => unknown) => select({ rooms: mocks.rooms }),
  useRosterStore: (select: (s: unknown) => unknown) => select({ contacts: mocks.contacts }),
}))
vi.mock('../Avatar', () => ({ getConsistentTextColor: () => 'rgb(1,2,3)' }))
vi.mock('@/hooks/useNavigateToTarget', () => ({ useNavigateToTarget: () => ({ navigateToConversation: mocks.navigate }) }))
vi.mock('@/stores/toastStore', () => ({ useToastStore: (select: (s: unknown) => unknown) => select({ addToast: mocks.toast }) }))
vi.mock('@/utils/deepLinkRouter', () => ({ routeDeepLink: mocks.route }))

const now = new Date()
const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0).getTime()
const yesterday = todayNoon - 24 * 3600 * 1000

function card(forwarded: Partial<ForwardedCopy>) {
  const message = { forwarded: { author: 'Bob', text: 'Ship it\nTonight', ...forwarded } as ForwardedCopy, references: [] }
  return render(<ForwardedCopyCard message={message} formatTime={() => '18:52'} />)
}

// FLM-332: the card names who wrote the original, where and when, and a click opens the original.
describe('ForwardedCopyCard', () => {
  beforeEach(() => {
    mocks.find.mockReset(); mocks.route.mockReset(); mocks.navigate.mockReset(); mocks.toast.mockReset()
    mocks.rooms.clear(); mocks.contacts.clear()
  })

  it('names a known room and shows the copied text with its line breaks', () => {
    mocks.rooms.set('tech@conference.example.org', { name: 'ProcessOne tech' })
    const { container } = card({ author: 'jenkins-msg-bot', from: 'tech@conference.example.org/jenkins-msg-bot', type: 'groupchat', timestamp: todayNoon })
    const el = container.querySelector('[data-forwarded-copy]')!
    expect(el.textContent).toContain('chat.forwardedFromLabel')
    expect(el.textContent).toContain('jenkins-msg-bot')
    expect(el.textContent).toContain('ProcessOne tech')
    expect(el.textContent).toContain('· 18:52')
    expect(el.textContent).not.toContain('dates.')
    expect(el.textContent).toContain('Ship it')
    expect(el.textContent).toContain('Tonight')
    expect(el.querySelector('[class*=select-text] br')).not.toBeNull()
  })

  it('names an unknown room by its full address', () => {
    const { container } = card({ from: 'tech@conference.example.org/Bob', type: 'groupchat' })
    expect(container.textContent).toContain('tech@conference.example.org')
  })

  it('says Direct chat and uses the contact name, falling back to the address', () => {
    mocks.contacts.set('memberbot@xmpp.org', { name: 'XSF Memberbot' })
    const { container, unmount } = card({ author: 'memberbot@xmpp.org', from: 'memberbot@xmpp.org', type: 'chat' })
    expect(container.textContent).toContain('XSF Memberbot')
    expect(container.textContent).toContain('chat.forwardedCopyDirectChat')
    unmount()
    mocks.contacts.clear()
    expect(card({ author: 'memberbot@xmpp.org', from: 'memberbot@xmpp.org', type: 'chat' }).container.textContent).toContain('memberbot@xmpp.org')
  })

  it('adds the day when the original is not from today', () => {
    const { container } = card({ type: 'chat', from: 'bob@example.org', timestamp: yesterday })
    expect(container.textContent).toContain('dates.yesterday 18:52')
  })

  it('opens a room original through the message link route', async () => {
    mocks.find.mockResolvedValue({ kind: 'room', roomJid: 'tech@conference.example.org', stanzaId: '77' })
    card({ type: 'groupchat', from: 'tech@conference.example.org/Bob' })
    fireEvent.click(screen.getByRole('link'))
    await waitFor(() => expect(mocks.route).toHaveBeenCalledWith('xmpp:tech@conference.example.org?join;msg=77'))
    expect(mocks.find).toHaveBeenCalledWith(expect.anything(), 'me@example.org/desktop', ['bob@example.org'])
  })

  it('opens a direct original in its conversation at that message, also with Enter', async () => {
    mocks.find.mockResolvedValue({ kind: 'chat', conversationId: 'bob@example.org', row: { id: 'm-9', stanzaId: 'a-2' } })
    card({ type: 'chat', from: 'bob@example.org' })
    fireEvent.keyDown(screen.getByRole('link'), { key: 'Enter' })
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('bob@example.org', { id: 'm-9', stanzaId: 'a-2' }))
  })

  it('stays put and says so when the original is not in local history', async () => {
    mocks.find.mockResolvedValue(null)
    card({ type: 'chat', from: 'bob@example.org' })
    fireEvent.click(screen.getByRole('link'))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('info', 'chat.forwardedOriginNotFound'))
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.route).not.toHaveBeenCalled()
  })

  it('does not look anything up while drawn, nor when a click ends a text selection', () => {
    card({ type: 'chat', from: 'bob@example.org' })
    expect(mocks.find).not.toHaveBeenCalled()
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'Ship' } as Selection)
    fireEvent.click(screen.getByRole('link'))
    expect(mocks.find).not.toHaveBeenCalled()
    selection.mockRestore()
  })
})

// FLM-336 finding 8: links in a copy are clickable like links in ordinary messages.
describe('ForwardedCopyCard links', () => {
  beforeEach(() => { mocks.find.mockReset(); mocks.route.mockReset() })

  it('draws a URL as a link, and following it does not open the original', () => {
    const { container } = card({ type: 'chat', from: 'bob@example.org', text: 'See https://example.org/a?b=1 now' })
    const anchor = container.querySelector('a')!
    expect(anchor.getAttribute('href')).toBe('https://example.org/a?b=1')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toContain('noopener')
    fireEvent.click(anchor)
    expect(mocks.find).not.toHaveBeenCalled()
  })

  it('still opens the original from the text around the link', async () => {
    mocks.find.mockResolvedValue(null)
    const { container } = card({ type: 'chat', from: 'bob@example.org', text: 'See https://example.org now' })
    fireEvent.click(container.querySelector('[data-forwarded-copy]')!)
    await waitFor(() => expect(mocks.find).toHaveBeenCalled())
  })

  it('opens the link menu on right-click without opening the original', () => {
    const { container } = card({ type: 'chat', from: 'bob@example.org', text: 'https://example.org' })
    fireEvent.contextMenu(container.querySelector('a')!)
    expect(mocks.find).not.toHaveBeenCalled()
    // The menu is portalled out of the card; choosing an item must not open the original either.
    const item = screen.getByText('chat.copyLink')
    expect(container.contains(item)).toBe(false)
    fireEvent.click(item)
    expect(mocks.find).not.toHaveBeenCalled()
  })

  it('leaves a script URL as plain text', () => {
    const { container } = card({ type: 'chat', from: 'bob@example.org', text: 'javascript:alert(1)' })
    expect(container.querySelector('a')).toBeNull()
  })
})

describe('ForwardedCopyCard stale lookups', () => {
  it('does nothing when the account changed or the card left while the lookup ran', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.find.mockReset(); mocks.navigate.mockReset(); mocks.toast.mockReset()
    mocks.find.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const { unmount } = card({ type: 'chat', from: 'bob@example.org' })
    fireEvent.click(screen.getByRole('link'))
    unmount()
    finish({ kind: 'chat', conversationId: 'bob@example.org', row: { id: 'm-9' } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  // FLM-403: the source label shares the header baseline: a label row aligned by its text, its icon centred on its own.
  it('aligns the source label with the name and time by their text baseline', () => {
    mocks.rooms.set('tech@conference.example.org', { name: 'ProcessOne tech' })
    card({ type: 'groupchat', from: 'tech@conference.example.org/bob', timestamp: todayNoon })
    const label = screen.getByText('ProcessOne tech')
    expect(label.className).toContain('items-baseline')
    expect(label.className).not.toContain('items-center')
    expect(label.querySelector('svg')!.getAttribute('class')).toContain('self-center')
  })
})
