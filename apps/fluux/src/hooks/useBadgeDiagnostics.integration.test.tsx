import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { xml } from '@xmpp/client'
import { XMPPClient } from '../../../../packages/fluux-sdk/src/core/XMPPClient'
import { Chat } from '../../../../packages/fluux-sdk/src/core/modules/Chat'
import { MAM } from '../../../../packages/fluux-sdk/src/core/modules/MAM'
import { createDefaultStoreBindings } from '../../../../packages/fluux-sdk/src/core/defaultStoreBindings'
import { createPresenceReader } from '../../../../packages/fluux-sdk/src/core/presenceReader'
import { E2EEManager, InMemoryStorageBackend, E2EEPluginError } from '../../../../packages/fluux-sdk/src/core/e2ee'
import { chatStore } from '../../../../packages/fluux-sdk/src/stores/chatStore'
import { rosterStore } from '../../../../packages/fluux-sdk/src/stores/rosterStore'
import { connectionStore } from '../../../../packages/fluux-sdk/src/stores/connectionStore'
import { roomStore } from '../../../../packages/fluux-sdk/src/stores/roomStore'
import { _clearAllViewportEvidenceForTesting, currentViewportGeneration, reportViewport } from '../../../../packages/fluux-sdk/src/stores/shared/viewportEvidence'
import { _clearAllTransientForTesting } from '../../../../packages/fluux-sdk/src/stores/shared/transientUnread'
import { _resetStorageScopeForTesting, getStorageScopeJid } from '../../../../packages/fluux-sdk/src/utils/storageScope'
import { useNotificationBadge } from './useNotificationBadge'
import { useWindowVisibility } from './useWindowVisibility'
import { DummyPlaintextPlugin } from '../../../../packages/fluux-sdk/src/core/e2ee/DummyPlaintextPlugin'
import { exportBadgeDiagnostics, startBadgeDiagnostics, resetBadgeDiagnosticsForTesting } from '@/utils/badgeDiagnostics'
import { saveMessageWithResult } from '../../../../packages/fluux-sdk/src/utils/messageCache'
import { setPlatformForTesting } from '@/platform'
// Use real React store subscriptions; the app test defaults deliberately replace them.
vi.unmock('@fluux/sdk/react')

// No account, native crypto, keychain, transport, or desktop is used.
vi.mock('@fluux/sdk', async (importOriginal) => ({ ...await importOriginal<any>(), useEvents: () => ({ pendingCount: 0 }) }))
const native = vi.hoisted(() => ({ badge: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setBadgeCount: native.badge }) }))
vi.mock('../../../../packages/fluux-sdk/src/utils/messageCache', async (importOriginal) => ({
  ...await importOriginal<any>(),
  saveMessageWithResult: vi.fn().mockResolvedValue(true), saveMessage: vi.fn().mockResolvedValue(undefined),
  getMessages: vi.fn().mockResolvedValue([]), getMessagesAround: vi.fn().mockResolvedValue([]),
}))
const SELF = 'receiver@example.test', PEER = 'sender@example.test'
let client: XMPPClient, chat: Chat, manager: E2EEManager, plugin: DummyPlaintextPlugin
let restorePlatform: () => void
const count = () => chatStore.getState().conversations.get(PEER)?.unreadCount
const last = () => chatStore.getState().lastArrivedMessage.get(PEER)
const key = () => ({ kind: 'chat' as const, entityId: PEER, accountScope: getStorageScopeJid() ?? '' })
function viewport(value: 'at-edge' | 'away') { reportViewport(key(), currentViewportGeneration(key()), value); }
function stanza() {
  return xml('message', { from: PEER + '/other', to: SELF, type: 'chat', id: 'fixture-message' },
    xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: SELF, id: 'fixture-archive' }),
    xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id: 'fixture-message' }),
    xml('active', { xmlns: 'http://jabber.org/protocol/chatstates' }),
    xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from('Disposable test text').toString('base64')),
    xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:fluux:e2ee-dummy:0' }),
    xml('store', { xmlns: 'urn:xmpp:hints' }),
    xml('body', {}, 'Encrypted message fallback'))
}
async function receive() { await act(async () => { chat.handle(stanza()); await chat.whenLiveDecryptsSettled(); }); }
// The original investigation's eight paths, now asserting the diagnostic boundary.
// DummyPlaintextPlugin owns the crypto stand-in; cache and native completion are controlled.
function events() { return JSON.parse(exportBadgeDiagnostics()).events as Array<Record<string, unknown>>; }
function trace(label: string) {
  const captured = events()
  expect(exportBadgeDiagnostics()).not.toContain(PEER)
  expect(exportBadgeDiagnostics()).not.toContain(SELF)
  expect(exportBadgeDiagnostics()).not.toContain('Disposable test text')
  expect(exportBadgeDiagnostics()).not.toContain('fixture-message')
  console.log('BADGE DIAGNOSTICS', label, JSON.stringify(captured))
}
beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('Network forbidden in diagnostic tests')))
  resetBadgeDiagnosticsForTesting()
  localStorage.clear()
  startBadgeDiagnostics()
  _resetStorageScopeForTesting()
  _clearAllTransientForTesting()
  _clearAllViewportEvidenceForTesting()
  chatStore.getState().reset()
  rosterStore.getState().reset()
  roomStore.getState().reset()
  connectionStore.getState().setWindowVisible(false)
  restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
  native.badge.mockReset().mockResolvedValue(undefined)
  client = new XMPPClient({ debug: false })
  rosterStore.getState().setContacts([{ jid: PEER, name: 'Fixture', presence: 'online', subscription: 'both' } as any])
  chatStore.getState().addConversation({ id: PEER, name: 'Fixture', type: 'chat', unreadCount: 0 })
  chatStore.getState().setActiveConversation(PEER)
  viewport('at-edge')
  manager = new E2EEManager({ storage: new InMemoryStorageBackend(), account: { jid: SELF }, xmpp: { sendStanza: async () => { }, queryDisco: async () => ({ features: [], identities: [] }), publishPEP: async () => { }, retractPEP: async () => { }, deletePEP: async () => { }, queryPEP: async () => [], subscribePEP: () => ({ unsubscribe: () => { } }) } })
  plugin = new DummyPlaintextPlugin()
  await manager.register(plugin)
  const deps: any = { stores: createDefaultStoreBindings(), presence: createPresenceReader(), getCurrentJid: () => SELF + '/lab', getXmpp: () => null, getE2EEManager: () => manager, sendStanza: async () => { }, sendIQ: async () => xml('iq', {}), emit: () => { }, emitSDK: (e: any, p: any) => (client as any).emitSDK(e, p) }
  chat = new Chat(deps, new MAM(deps))
  renderHook(() => useNotificationBadge())
  await vi.waitFor(() => expect(native.badge).toHaveBeenCalledWith(undefined))
  native.badge.mockClear()
})
afterEach(async () => { cleanup(); resetBadgeDiagnosticsForTesting(); client.destroy(); await manager.shutdown(); restorePlatform(); vi.restoreAllMocks(); vi.unstubAllGlobals(); chatStore.getState().reset(); rosterStore.getState().reset(); roomStore.getState().reset(); })
describe('automatic badge diagnostics through message dispatch and stores', () => {
  it('hidden active chat: decrypts, increments unread, calls Dock with 1; later local read clears', async () => {
    await receive()
    expect(last()?.body).toBe('Disposable test text')
    expect(count()).toBe(1)
    expect(events()).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'decrypt-complete', status: 'succeeded' }), expect.objectContaining({ phase: 'arrival', status: 'accepted', unreadBefore: 0, unreadAfter: 1 }), expect.objectContaining({ phase: 'storage', status: 'succeeded' })]))
    await vi.waitFor(() => expect(native.badge).toHaveBeenCalledWith(1))
    const message = events().find(event => event.phase === 'decrypt-start')?.message
    expect(message).toBeDefined()
    for (const phase of ['decrypt-complete', 'arrival', 'storage']) {
      expect(events().filter(event => event.phase === phase).every(event => event.message === message)).toBe(true)
    }
    trace('hidden success')
    await act(async () => { connectionStore.getState().setWindowVisible(true); chatStore.getState().markAsRead(PEER); })
    expect(count()).toBe(0)
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'read-decision', unreadBefore: 1, unreadAfter: 0 }))
    await vi.waitFor(() => expect(native.badge).toHaveBeenLastCalledWith(undefined))
    trace('later read')
  })
  it('completed decrypt failure still stores a renderable placeholder and calls Dock with 1', async () => {
    vi.spyOn(plugin, 'decrypt').mockRejectedValue(new E2EEPluginError('transient', 'key-locked', 'fixture unavailable key'))
    await receive()
    expect(last()?.encryptedPayload).toBeTruthy()
    expect(count()).toBe(1)
    await vi.waitFor(() => expect(native.badge).toHaveBeenCalledWith(1))
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'decrypt-complete', status: 'failed' }))
    trace('hidden completed failure')
  })
  it('a not-yet-registered plugin still stores fallback and calls Dock with 1', async () => {
    await manager.unregister('dummy-plaintext')
    await receive()
    expect(last()?.encryptedPayload).toBeTruthy()
    expect(count()).toBe(1)
    await vi.waitFor(() => expect(native.badge).toHaveBeenCalledWith(1))
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'decrypt-complete', status: 'unavailable' }))
    trace('hidden no plugin')
  })
  it('visible active chat at bottom: no unread increment and no Dock 1', async () => {
    connectionStore.getState().setWindowVisible(true)
    await receive()
    expect(count()).toBe(0)
    expect(native.badge).not.toHaveBeenCalledWith(1)
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'arrival', status: 'pending', active: true, visible: true, viewportAtEdge: true }))
    trace('visible at edge')
  })
  it('visible active chat scrolled up: unread 1 and Dock 1', async () => {
    connectionStore.getState().setWindowVisible(true)
    viewport('away')
    await receive()
    expect(count()).toBe(1)
    await vi.waitFor(() => expect(native.badge).toHaveBeenCalledWith(1))
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'arrival', status: 'pending', active: true, visible: true, viewportAtEdge: false }))
    trace('visible away')
  })
  it('native setter rejection records failure without changing unread state', async () => {
    native.badge.mockRejectedValue(new Error('fixture native badge failure'))
    await receive()
    expect(count()).toBe(1)
    await vi.waitFor(() => expect(native.badge).toHaveBeenCalledWith(1))
    await vi.waitFor(() => expect(events()).toContainEqual(expect.objectContaining({ phase: 'badge-result', status: 'failed', count: 1 })))
    expect(exportBadgeDiagnostics()).not.toContain('fixture native badge failure')
    trace('native rejection recorded')
  })
  it('hidden document retaining focus: the actual visibility hook prevents an immediate read', async () => {
    connectionStore.getState().setWindowVisible(true)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    renderHook(() => useWindowVisibility())
    expect(connectionStore.getState().windowVisible).toBe(false)
    await receive()
    expect(count()).toBe(1)
    await vi.waitFor(() => expect(native.badge).toHaveBeenCalledWith(1))
    trace('hidden document retains focus')
  })
  it('an unfinished decrypt has no stored message or unread count until it resolves', async () => {
    const original = plugin.decrypt.bind(plugin)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve; })
    vi.spyOn(plugin, 'decrypt').mockImplementation(async (...a) => { await held; return original(...a); })
    await act(async () => { chat.handle(stanza()); await Promise.resolve(); })
    expect(last()).toBeUndefined()
    expect(count()).toBe(0)
    expect(native.badge).not.toHaveBeenCalledWith(1)
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'decrypt-start', status: 'pending' }))
    expect(events().some(e => e.phase === 'decrypt-complete')).toBe(false)
    trace('decrypt pending')
    await act(async () => { release(); await chat.whenLiveDecryptsSettled(); })
    expect(count()).toBe(1)
    await vi.waitFor(() => expect(native.badge).toHaveBeenCalledWith(1))
    trace('decrypt released')
  })
  it('pairs overlapping native requests with their own results', async () => {
    let resolveFirst!: () => void
    native.badge.mockImplementationOnce(() => new Promise<void>(resolve => { resolveFirst = resolve; }))
    await receive()
    await vi.waitFor(() => expect(native.badge).toHaveBeenCalledWith(1))
    const first = events().filter(e => e.phase === 'badge-request' && e.count === 1).at(-1)!
    await act(async () => { connectionStore.getState().setWindowVisible(true); chatStore.getState().markAsRead(PEER); })
    await vi.waitFor(() => expect(events()).toContainEqual(expect.objectContaining({ phase: 'badge-result', status: 'succeeded', count: 0 })))
    await act(async () => { resolveFirst(); })
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'badge-result', status: 'succeeded', count: 1, request: first.request }))
  })
  it('records failed durable writes separately from accepted arrival', async () => {
    vi.mocked(saveMessageWithResult).mockResolvedValueOnce(false)
    await receive()
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'arrival', status: 'accepted' }))
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'storage', status: 'failed' }))
  })
  it('keeps a duplicate from creating a second unread count', async () => {
    await receive()
    await receive()
    expect(count()).toBe(1)
    expect(events().filter(e => e.phase === 'arrival' && e.status === 'accepted' && e.unreadBefore === 0 && e.unreadAfter === 1)).toHaveLength(1)
  })
  it('records room arrival and read-state changes without identifiers', async () => {
    const room = 'lounge@conference.example.test'
    roomStore.getState().addRoom({ jid: room, name: 'Lounge', nickname: 'reader', joined: true,
      isBookmarked: false, occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set() })
    await act(async () => {
      chat.handle(xml('message', { from: room + '/writer', to: SELF, type: 'groupchat', id: 'room-private-message' },
        xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: room, id: 'room-archive-message' }),
        xml('body', {}, 'Room private text')))
      await roomStore.getState().waitForMessageArrivals(room)
    })
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'arrival', entityKind: 'room', status: 'accepted' }))
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'read-state', entityKind: 'room', unreadAfter: expect.any(Number) }))
    expect(exportBadgeDiagnostics()).not.toContain(room)
    expect(exportBadgeDiagnostics()).not.toContain('Room private text')
    expect(exportBadgeDiagnostics()).not.toContain('room-private-message')
  })
  it('records synchronized chat read changes separately from receipt', async () => {
    await receive()
    await act(async () => { chatStore.getState().applyRemoteDisplayed(PEER, 'fixture-archive') })
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'read-state', entityKind: 'chat', pointerChanged: true }))
  })

})
