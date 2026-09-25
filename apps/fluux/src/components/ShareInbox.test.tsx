import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { setPlatformForTesting } from '@/platform'
import { nativeShareInbox } from '@/utils/shareInbox'
import { ShareInbox } from './ShareInbox'
import type { ShareInbox as InboxAPI } from '@/utils/shareInbox'

const mocks = vi.hoisted(() => ({ send: vi.fn(), upload: vi.fn(), account: 'me@example.com' }))
vi.mock('@fluux/sdk', () => ({
  getStorageScopeJid: () => mocks.account,
  useConnectionStatus: () => ({ jid: mocks.account, isConnected: true }),
  useChatActions: () => ({ sendMessage: mocks.send }),
  roomStore: { getState: () => ({ rooms: new Map() }) },
}))
const rooms = new Map()
vi.mock('@fluux/sdk/react', () => ({ useRoomStore: (select: (s: unknown) => unknown) => select({ rooms }) }))
vi.mock('@/hooks/useFileUpload', () => ({ useFileUpload: () => ({ isSupported: true, uploadFile: mocks.upload }) }))
vi.mock('@/hooks/useConversationEncryptionState', () => ({ useConversationEncryptionState: () => ({ kind: 'disabled' }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./ModalShell', () => ({ ModalShell: ({ children, onClose }: { children: ReactNode; onClose: () => void }) => <div role="dialog"><button type="button" onClick={onClose}>Close</button>{children}</div> }))
vi.mock('./ContactSelector', () => ({ ContactSelector: ({ onPick }: { onPick: (jid: string) => void }) => <button type="button" onClick={() => onPick('friend@example.com')}>Friend</button> }))
vi.mock('./MessageComposer', () => ({ MessageComposer: ({ value, onSend, disabled, sendDisabled }: { value: string; onSend: (text: string) => void; disabled: boolean; sendDisabled: boolean }) => <button type="button" disabled={disabled || sendDisabled} onClick={() => void onSend(value)}>Send {value}</button> }))

function inbox(): InboxAPI {
  let items = [{ id: 'shared-link', text: 'https://fluux.io', name: null, mime: null, size: 0 }]
  return { list: vi.fn(async () => [...items]), file: vi.fn(async () => undefined), remove: vi.fn(async () => { items = [] }) }
}
beforeEach(() => { mocks.send.mockReset().mockResolvedValue('message'); mocks.upload.mockReset(); mocks.account = 'me@example.com' })
describe('imported shares', () => {
  it('hides the launcher when loading fails without known imports, then recovers on focus', async () => {
    const api = inbox()
    vi.mocked(api.list).mockRejectedValueOnce(new Error('Share storage unavailable'))
    render(<ShareInbox api={api} />)
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button', { name: /sharing.title/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.focus(window)
    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'sharing.title (1)' })).toBeInTheDocument()
  })
  it('hides the launcher for an empty inbox', async () => {
    const api = inbox()
    vi.mocked(api.list).mockResolvedValue([])
    render(<ShareInbox api={api} />)
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button', { name: /sharing.title/ })).not.toBeInTheDocument()
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
  it('can close and resume without uploading, sending, or losing the item', async () => {
    const api = inbox()
    render(<ShareInbox api={api} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByText('Close'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.remove).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /sharing.title/ }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByText('Friend'))
    const send = await screen.findByRole('button', { name: 'Send https://fluux.io' })
    await waitFor(() => expect(send).toBeEnabled())
    fireEvent.click(send)
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('shared-link'))
    expect(mocks.send).toHaveBeenCalledWith('friend@example.com', 'https://fluux.io', { attachment: undefined })
    await waitFor(() => expect(screen.queryByRole('button', { name: /sharing.title/ })).not.toBeInTheDocument())
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
