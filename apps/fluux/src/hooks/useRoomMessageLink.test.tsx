import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { connectionStore, roomStore, type RoomMessage } from '@fluux/sdk'
import { useRoomMessageLink } from './useRoomMessageLink'

const { locate, bridge, navigate, toast } = vi.hoisted(() => ({
  locate: vi.fn(), bridge: vi.fn(), navigate: vi.fn(), toast: vi.fn(),
}))
vi.mock('@fluux/sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@fluux/sdk')>(),
  useXMPPContext: () => ({ client: { messages: { locateRoomMessage: locate, catchUpTo: bridge } } }),
}))
vi.mock('./useNavigateToTarget', () => ({ useNavigateToTarget: () => ({ navigateToRoom: navigate }) }))
vi.mock('@/stores/toastStore', () => ({ useToastStore: (select: (state: { addToast: typeof toast }) => unknown) => select({ addToast: toast }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }))

const link = { roomJid: 'team@conference.example.org', stanzaId: '1731490000123456' }
const message: RoomMessage = { type: 'groupchat', roomJid: link.roomJid, id: 'team-update', stanzaId: link.stanzaId,
  originId: undefined, from: `${link.roomJid}/Bob`, nick: 'Bob', occupantId: 'bob', body: 'Team update',
  timestamp: new Date('2026-05-01T10:00:00Z'), isOutgoing: false }

beforeEach(() => {
  vi.resetAllMocks()
  roomStore.getState().reset()
  connectionStore.getState().setJid('alice@example.org/web')
  connectionStore.getState().setStatus('online')
  bridge.mockResolvedValue(undefined)
  locate.mockResolvedValue({ kind: 'found', message, source: 'resident' })
})
afterEach(() => { roomStore.getState().reset(); connectionStore.getState().setJid(null); connectionStore.getState().setStatus('disconnected'); vi.restoreAllMocks() })

// Room links (docs/URL_SCHEMES.md): do not join on a shared link; resume after a deliberate
// join, preserve opaque row identity, distinguish absence from failure, and
// never let a previous account's async resolution navigate the new account.
describe('room message link navigation', () => {
  it('opens an unknown room with Join, without archive lookup, then resumes after joining', async () => {
    const { result } = renderHook(useRoomMessageLink)
    act(() => result.current(link))
    expect(navigate).toHaveBeenCalledWith(link.roomJid)
    expect(roomStore.getState().rooms.get(link.roomJid)?.joined).toBe(false)
    expect(locate).not.toHaveBeenCalled()
    act(() => roomStore.getState().addRoom({ ...roomStore.getState().rooms.get(link.roomJid)!, joined: true }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(link.roomJid, expect.objectContaining({ id: message.id, stanzaId: link.stanzaId })))
    expect(locate).toHaveBeenCalledTimes(1)
    expect(bridge).not.toHaveBeenCalled()
  })

  it('drops a link its owner no longer wants, so a late success never navigates', async () => {
    let owned = true
    const { result } = renderHook(useRoomMessageLink)
    act(() => result.current(link, undefined, () => owned))
    navigate.mockClear()
    owned = false
    act(() => roomStore.getState().addRoom({ ...roomStore.getState().rooms.get(link.roomJid)!, joined: true }))
    await Promise.resolve()
    expect(locate).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  // A conservative gap can survive a completed bridge. Local targets must not
  // repeat that archive walk on later opens; only fresh archive context needs it.
  it.each(['resident', 'cache', 'archive'] as const)('bridges only archive-fetched targets when a gap remains: %s', async source => {
    locate.mockResolvedValue({ kind: 'found', message, source })
    const { result } = renderHook(useRoomMessageLink)
    act(() => result.current(link))
    act(() => {
      roomStore.setState({ roomGaps: new Map([[link.roomJid, [{ start: +message.timestamp, startId: link.stanzaId }]]]) })
      roomStore.getState().addRoom({ ...roomStore.getState().rooms.get(link.roomJid)!, joined: true })
    })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(link.roomJid, expect.objectContaining({ stanzaId: link.stanzaId })))
    expect(bridge).toHaveBeenCalledTimes(source === 'archive' ? 1 : 0)
    if (source === 'archive') expect(bridge).toHaveBeenCalledWith(link.roomJid, message.timestamp.toISOString())
  })

  it.each([false, true])('waits for the earlier bridge and keeps account authority: account changes %s', async accountChanges => {
    // Real archive proof: an older link starts a bridge, then a new live row is
    // linked before it finishes. Its late pages must not displace the new target.
    let finishBridge!: () => void
    bridge.mockReturnValueOnce(new Promise<void>(resolve => { finishBridge = resolve }))
    const newer = { ...message, id: 'body-link-note', stanzaId: 'newer-room-entry',
      body: 'Reference: xmpp:team@conference.example.org?join;msg=earlier-entry',
      timestamp: new Date(message.timestamp.getTime() + 1000) }
    locate.mockResolvedValueOnce({ kind: 'found', message, source: 'archive' })
      .mockResolvedValueOnce({ kind: 'found', message: newer, source: 'resident' })
    const { result } = renderHook(useRoomMessageLink)
    act(() => result.current(link))
    act(() => {
      roomStore.setState({ roomGaps: new Map([[link.roomJid, [{ start: +message.timestamp, startId: link.stanzaId }]]]) })
      roomStore.getState().addRoom({ ...roomStore.getState().rooms.get(link.roomJid)!, joined: true })
    })
    await waitFor(() => expect(bridge).toHaveBeenCalledTimes(1))
    navigate.mockClear()
    await act(async () => result.current({ roomJid: link.roomJid, stanzaId: newer.stanzaId }))
    if (accountChanges) act(() => connectionStore.getState().setJid('carol@example.org/web'))
    try { expect(navigate).not.toHaveBeenCalled() }
    finally { await act(async () => finishBridge()) }
    if (accountChanges) expect(navigate).not.toHaveBeenCalled()
    else await waitFor(() => expect(navigate).toHaveBeenCalledWith(link.roomJid, expect.objectContaining({ stanzaId: newer.stanzaId })))
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['absent', 'This message is no longer available'],
    ['unknown', 'Could not load this message'],
  ])('settles a %s target with the correct notice and no repeated lookup', async (kind, notice) => {
    const { result } = renderHook(useRoomMessageLink)
    act(() => result.current(link))
    locate.mockResolvedValue({ kind })
    vi.spyOn(roomStore.getState(), 'recenterToLatest').mockResolvedValue(true)
    act(() => roomStore.getState().addRoom({ ...roomStore.getState().rooms.get(link.roomJid)!, joined: true }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('error', notice))
    act(() => roomStore.setState({ activeRoomJid: link.roomJid }))
    expect(locate).toHaveBeenCalledTimes(1)
    expect(bridge).not.toHaveBeenCalled()
  })

  it('reports a failed archive lookup after network membership resets, without retrying after reconnect', async () => {
    let finish!: (value: { kind: 'unknown' }) => void
    locate.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    vi.spyOn(roomStore.getState(), 'recenterToLatest').mockResolvedValue(true)
    const { result } = renderHook(useRoomMessageLink)
    act(() => result.current(link))
    act(() => roomStore.getState().addRoom({ ...roomStore.getState().rooms.get(link.roomJid)!, joined: true }))
    await act(async () => {
      connectionStore.getState().setStatus('disconnected')
      roomStore.getState().addRoom({ ...roomStore.getState().rooms.get(link.roomJid)!, joined: false })
      finish({ kind: 'unknown' })
    })
    await waitFor(() => expect(toast).toHaveBeenCalledWith('error', 'Could not load this message'))
    act(() => {
      connectionStore.getState().setStatus('online')
      roomStore.getState().addRoom({ ...roomStore.getState().rooms.get(link.roomJid)!, joined: true })
    })
    expect(locate).toHaveBeenCalledTimes(1)
  })

  it('ignores an old account result', async () => {
    let finish!: (value: { kind: 'found'; message: RoomMessage; source: 'resident' }) => void
    locate.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const { result } = renderHook(useRoomMessageLink)
    act(() => result.current(link))
    act(() => roomStore.getState().addRoom({ ...roomStore.getState().rooms.get(link.roomJid)!, joined: true }))
    navigate.mockClear()
    await act(async () => {
      connectionStore.getState().setJid('carol@example.org/web')
      finish({ kind: 'found', message, source: 'resident' })
    })
    expect(navigate).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })
})
