import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
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
