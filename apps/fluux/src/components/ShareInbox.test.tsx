import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { setPlatformForTesting } from '@/platform'
import { nativeShareInbox } from '@/utils/shareInbox'
import { ShareInbox } from './ShareInbox'
import type { ShareInbox as InboxAPI } from '@/utils/shareInbox'

const mocks = vi.hoisted(() => ({ send: vi.fn(), upload: vi.fn(), toChat: vi.fn(), toRoom: vi.fn(), account: 'me@example.com', rosterLoaded: true }))
vi.mock('@fluux/sdk', () => ({
  getStorageScopeJid: () => mocks.account,
  useConnectionStatus: () => ({ jid: mocks.account, isConnected: true }),
  useChatActions: () => ({ sendMessage: mocks.send }),
  roomStore: { getState: () => ({ rooms }) },
  rosterStore: { getState: () => ({ contacts, accountJid: mocks.account, isLoaded: mocks.rosterLoaded }) },
}))
let rooms = new Map()
const contacts = new Map([['friend@example.com', { name: 'Friend Name' }]])
vi.mock('@fluux/sdk/react', () => ({ useRoomStore: (select: (s: unknown) => unknown) => select({ rooms }), useRosterStore: (select: (s: unknown) => unknown) => select({ contacts, accountJid: mocks.account, isLoaded: mocks.rosterLoaded }) }))
vi.mock('@/platform/ios/shareSuggestions', () => ({ donateIOSConversation: vi.fn() }))
vi.mock('@/hooks/useFileUpload', () => ({ useFileUpload: () => ({ isSupported: true, uploadFile: mocks.upload }) }))
vi.mock('@/hooks/useNavigateToTarget', () => ({ useNavigateToTarget: () => ({ navigateToConversation: mocks.toChat, navigateToRoom: mocks.toRoom }) }))
vi.mock('@/hooks/useConversationEncryptionState', () => ({ useConversationEncryptionState: () => ({ kind: 'disabled' }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./ModalShell', () => ({ ModalShell: ({ children, onClose }: { children: ReactNode; onClose: () => void }) => <div role="dialog"><button type="button" onClick={onClose}>Close</button>{children}</div> }))
vi.mock('./ContactSelector', () => ({ ContactSelector: ({ onPick }: { onPick: (jid: string) => void }) => <button type="button" onClick={() => onPick('friend@example.com')}>Friend</button> }))
vi.mock('./MessageComposer', () => ({ MessageComposer: ({ value, onSend, disabled, sendDisabled }: { value: string; onSend: (text: string) => void; disabled: boolean; sendDisabled: boolean }) => <button type="button" disabled={disabled || sendDisabled} onClick={() => void onSend(value)}>Send {value}</button> }))

function inbox(): InboxAPI {
  let items = [{ id: 'shared-link', text: 'https://fluux.io', name: null, mime: null, size: 0 }]
  return { list: vi.fn(async () => [...items]), file: vi.fn(async () => undefined), remove: vi.fn(async () => { items = [] }) }
}
beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue('message')
  mocks.upload.mockReset()
  mocks.toChat.mockReset()
  mocks.toRoom.mockReset()
  mocks.account = 'me@example.com'
  mocks.rosterLoaded = true
  rooms = new Map()
})
describe('imported shares', () => {
  it('preselects a valid suggestion but waits for Send and allows changing it', async () => {
    const api = inbox()
    vi.mocked(api.list).mockResolvedValue([{ id: 'suggested', text: 'link', name: null, mime: null, size: 0,
      suggestedDestination: { account: mocks.account, jid: 'friend@example.com', type: 'chat' } }])
    render(<ShareInbox api={api} />)
    await screen.findByText('Friend Name')
    expect(mocks.send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('common.back'))
    await screen.findByText('Friend')
    expect(screen.queryByText('Friend Name')).not.toBeInTheDocument()
  })
  it('keeps a room suggestion pending until the room joins', async () => {
    const api = inbox()
    vi.mocked(api.list).mockResolvedValue([{ id: 'suggested', text: 'link', name: null, mime: null, size: 0,
      suggestedDestination: { account: mocks.account, jid: 'room@example.com', type: 'groupchat' } }])
    const view = render(<ShareInbox api={api} />)
    await screen.findByText('Friend')
    expect(screen.queryByRole('button', { name: 'Send link' })).not.toBeInTheDocument()
    rooms = new Map(rooms)
    rooms.set('room@example.com', { jid: 'room@example.com', name: 'Suggested Room', joined: true })
    view.rerender(<ShareInbox api={api} />)
    await screen.findByText('Suggested Room')
    expect(screen.getByText('common.back')).toBeInTheDocument()
    expect(mocks.send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('common.back'))
    rooms = new Map(rooms)
    rooms.set('another@example.com', { jid: 'another@example.com', name: 'Another Room', joined: true })
    view.rerender(<ShareInbox api={api} />)
    expect(screen.queryByText('common.back')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Suggested Room' })).toBeInTheDocument()
  })
  it.each(['Friend', 'Manual Room'])('preserves a manual %s choice when the roster finishes loading', async (choice) => {
    mocks.rosterLoaded = false
    rooms.set('manual@example.com', { jid: 'manual@example.com', name: 'Manual Room', joined: true })
    const api = inbox()
    vi.mocked(api.list).mockResolvedValue([{ id: 'suggested', text: 'link', name: null, mime: null, size: 0,
      suggestedDestination: { account: mocks.account, jid: 'friend@example.com', type: 'chat' } }])
    const view = render(<ShareInbox api={api} />)
    fireEvent.click(await screen.findByText(choice))
    await screen.findByRole('button', { name: 'Send link' })
    mocks.rosterLoaded = true
    view.rerender(<ShareInbox api={api} />)
    expect(screen.queryByText('Friend Name')).not.toBeInTheDocument()
    expect(screen.getByText(choice === 'Friend' ? 'friend@example.com' : 'Manual Room')).toBeInTheDocument()
    expect(mocks.send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('common.back'))
    mocks.rosterLoaded = false
    view.rerender(<ShareInbox api={api} />)
    mocks.rosterLoaded = true
    view.rerender(<ShareInbox api={api} />)
    expect(screen.queryByText('common.back')).not.toBeInTheDocument()
    expect(screen.getByText('Friend')).toBeInTheDocument()
  })
  it('ignores suggestions owned by a different account', async () => {
    const api = inbox()
    vi.mocked(api.list).mockResolvedValue([{ id: 'suggested', text: 'link', name: null, mime: null, size: 0,
      suggestedDestination: { account: 'other@example.com', jid: 'friend@example.com', type: 'chat' } }])
    render(<ShareInbox api={api} />)
    await screen.findByText('Friend')
    expect(screen.queryByText('Friend Name')).not.toBeInTheDocument()
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('opens nothing when loading fails, then opens the import on focus', async () => {
    const api = inbox()
    vi.mocked(api.list).mockRejectedValueOnce(new Error('Share storage unavailable'))
    render(<ShareInbox api={api} />)
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.focus(window)
    await screen.findByRole('dialog')
  })
  it('opens nothing for an empty inbox', async () => {
    const api = inbox()
    vi.mocked(api.list).mockResolvedValue([])
    render(<ShareInbox api={api} />)
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('receives native imports on macOS without enabling them on the web', async () => {
    const api = inbox()
    const list = vi.spyOn(nativeShareInbox, 'list').mockImplementation(api.list)
    const file = vi.spyOn(nativeShareInbox, 'file').mockImplementation(api.file)
    const restoreMac = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    const view = render(<ShareInbox />)
    try {
      await screen.findByRole('dialog')
      expect(list).toHaveBeenCalled()
      view.unmount()
      restoreMac()
      list.mockClear()
      const restoreWeb = setPlatformForTesting({ shell: 'web', os: 'macos' })
      const web = render(<ShareInbox />)
      expect(list).not.toHaveBeenCalled()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      web.unmount()
      restoreWeb()
    } finally { view.unmount(); restoreMac(); list.mockRestore(); file.mockRestore() }
  })
  it.each(['common.cancel', 'Close'])('discards the import on %s without choosing a conversation', async (label) => {
    const api = inbox()
    render(<ShareInbox api={api} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByText(label))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('shared-link'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('sends to the chosen conversation, removes the import and opens the conversation', async () => {
    const api = inbox()
    render(<ShareInbox api={api} />)
    fireEvent.click(await screen.findByText('Friend'))
    const send = await screen.findByRole('button', { name: 'Send https://fluux.io' })
    await waitFor(() => expect(send).toBeEnabled())
    fireEvent.click(send)
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('shared-link'))
    expect(mocks.send).toHaveBeenCalledWith('friend@example.com', 'https://fluux.io', { attachment: undefined })
    expect(mocks.toChat).toHaveBeenCalledWith('friend@example.com')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
  it('retains a failed send and offers a retry', async () => {
    mocks.send.mockRejectedValueOnce(new Error('offline'))
    const api = inbox()
    render(<ShareInbox api={api} />)
    fireEvent.click(await screen.findByText('Friend'))
    const send = await screen.findByRole('button', { name: 'Send https://fluux.io' })
    await waitFor(() => expect(send).toBeEnabled())
    fireEvent.click(send)
    await screen.findByRole('alert')
    expect(api.remove).not.toHaveBeenCalled()
    await waitFor(() => expect(send).toBeEnabled())
    fireEvent.click(send)
    await waitFor(() => expect(api.remove).toHaveBeenCalledOnce())
  })
})
