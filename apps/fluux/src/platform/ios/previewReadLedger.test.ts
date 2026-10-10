import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalReadEvent, Message } from '@fluux/sdk'
import { makeReadPointer } from '@fluux/sdk'
import { createPreviewController } from './notificationPreviews'
import { postPluginNotification } from '@/utils/postPluginNotification'
import { setPlatformForTesting } from '@/platform'
import { useIOSPreviewSettingsStore } from './previewSettings'
import { clearPreviewLedgerSession, setPreviewLedgerSession, startIOSReadLedger, reserveIOSNotification } from './previewReadLedger'
const lab = vi.hoisted(() => ({
  account: 'bob@nse.invalid', callback: undefined as ((event: LocalReadEvent) => void) | undefined,
  messages: new Map<string, Message[]>(), getMessages: vi.fn(), getMessage: vi.fn(), invoke: vi.fn(),
}))
vi.mock('@fluux/sdk', async (original) => ({
  ...await original<typeof import('@fluux/sdk')>(),
  connectionStore: { getState: () => ({ jid: lab.account + '/synthetic' }), subscribe: () => () => {} },
  chatStore: { getState: () => ({ messages: lab.messages }) },
  subscribeLocalReads: (callback: (event: LocalReadEvent) => void) => { lab.callback = callback; return () => { lab.callback = undefined } },
}))
vi.mock('@fluux/sdk/cache', () => ({ getMessages: lab.getMessages, getMessage: lab.getMessage }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: lab.invoke }))
function message(id: string, time: number, stanzaId?: string): Message {
  return { type: 'chat', id, stanzaId, ownArchiveId: stanzaId, ownArchiveBy: lab.account, originId: 'origin-' + id, conversationId: 'alice@nse.invalid', from: 'alice@nse.invalid', body: 'synthetic', timestamp: new Date(time), isOutgoing: false }
}
describe('app read/displayed ID union deltas', () => {
  let restore: () => void
  let stop: () => void
  beforeEach(() => {
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    vi.clearAllMocks(); lab.account = 'bob@nse.invalid'; lab.messages.clear()
    lab.getMessages.mockResolvedValue([]); lab.getMessage.mockResolvedValue(undefined); lab.invoke.mockResolvedValue({ allowed: true })
    setPreviewLedgerSession({ account: lab.account, epoch: 'synthetic-epoch' })
    stop = startIOSReadLedger()
  })
  afterEach(() => { stop(); clearPreviewLedgerSession(); useIOSPreviewSettingsStore.setState({ account: null, enabled: false }); restore() })
  it('withholds opted-in app submissions until a shared claim session is available', async () => {
    clearPreviewLedgerSession()
    useIOSPreviewSettingsStore.setState({ account: lab.account, enabled: true })
    expect(await reserveIOSNotification('alice@nse.invalid', 'pending', lab.account, 'synthetic-request')).toBe(false)
    expect(lab.invoke).not.toHaveBeenCalled()
    useIOSPreviewSettingsStore.setState({ enabled: false })
    expect(await reserveIOSNotification('alice@nse.invalid', 'pending', lab.account, 'synthetic-request')).toBe(true)
  })
  it('flushes a confirmed cold-start read after deferred provisioning and closing the conversation', async () => {
    clearPreviewLedgerSession()
    useIOSPreviewSettingsStore.setState({ account: lab.account, enabled: true })
    const read = message('startup-read', 2, 'u-startup')
    lab.messages.set(read.conversationId, [read])
    let finish!: (material: Record<string, unknown>) => void
    const prepare = vi.fn(() => new Promise<Record<string, unknown>>(resolve => { finish = resolve }))
    const controller = createPreviewController({
      state: () => ({ account: lab.account, enabled: true, ready: true, peers: {} }), prepare,
      write: async snapshot => { if (snapshot) setPreviewLedgerSession({ account: lab.account, epoch: 'retained-epoch' }) },
    })
    const provisioning = controller.refresh()
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled())
    lab.callback?.({ account: lab.account, kind: 'chat', conversationId: read.conversationId, pointer: makeReadPointer(read, 'chat'), messageOnly: true })
    lab.messages.clear()
    expect(lab.invoke).not.toHaveBeenCalled()
    finish({})
    await provisioning
    await vi.waitFor(() => expect(lab.invoke).toHaveBeenCalled())
    expect(lab.invoke.mock.calls[0][1].deltas).toEqual([{
      uid: 'u-startup', key: 'stanzaId:u-startup', archiveAuthority: lab.account, account: lab.account,
      epoch: 'retained-epoch', conversation: read.conversationId, read: true, notified: false,
    }])
  })
  it.each(['logout', 'opt-out', 'switch'])('drops pending reads on %s', async reason => {
    clearPreviewLedgerSession()
    useIOSPreviewSettingsStore.setState({ account: lab.account, enabled: true })
    const read = message('retired-read', 2, 'u-retired')
    lab.messages.set(read.conversationId, [read])
    lab.callback?.({ account: lab.account, kind: 'chat', conversationId: read.conversationId, pointer: makeReadPointer(read, 'chat'), messageOnly: true })
    if (reason === 'logout') clearPreviewLedgerSession()
    if (reason === 'opt-out') useIOSPreviewSettingsStore.setState({ enabled: false })
    if (reason === 'switch') lab.account = 'other@nse.invalid'
    setPreviewLedgerSession({ account: lab.account, epoch: 'new-epoch' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(lab.invoke).not.toHaveBeenCalled()
  })
  it('merges cached and resident locally-read messages, excluding rows beyond the read position', async () => {
    const old = message('old', 1, 'u-old'), read = message('read', 2, 'u-read'), unseen = message('unseen', 3)
    lab.getMessages.mockResolvedValue([old]); lab.messages.set(read.conversationId, [read, unseen])
    lab.callback?.({ account: lab.account, kind: 'chat', conversationId: read.conversationId, pointer: makeReadPointer(read, 'chat') })
    await vi.waitFor(() => expect(lab.invoke).toHaveBeenCalled())
    const args = lab.invoke.mock.calls[0][1]
    expect(args.operation).toBe('merge')
    expect(args.deltas).toEqual([
      { account: lab.account, epoch: 'synthetic-epoch', conversation: read.conversationId, uid: 'u-old', key: 'stanzaId:u-old', archiveAuthority: lab.account, read: true, notified: false },
      { account: lab.account, epoch: 'synthetic-epoch', conversation: read.conversationId, uid: 'u-read', key: 'stanzaId:u-read', archiveAuthority: lab.account, read: true, notified: false },
    ])
    expect(JSON.stringify(args)).not.toContain('synthetic"')
  })
  it('preserves cached own-archive identity over an older captured resident read', async () => {
    const live = message('backfilled', 2)
    const archived = message('backfilled', 2, 'personal-uid')
    lab.messages.set(live.conversationId, [live])
    let finish!: (messages: Message[]) => void
    lab.getMessages.mockReturnValue(new Promise<Message[]>(resolve => { finish = resolve }))
    lab.callback?.({ account: lab.account, kind: 'chat', conversationId: live.conversationId, pointer: makeReadPointer(live, 'chat') })
    await vi.waitFor(() => expect(lab.getMessages).toHaveBeenCalled())
    lab.messages.clear()
    finish([archived])
    await vi.waitFor(() => expect(lab.invoke).toHaveBeenCalled())
    expect(lab.invoke.mock.calls[0][1].deltas).toEqual([{
      uid: 'personal-uid', key: 'stanzaId:personal-uid', archiveAuthority: lab.account, account: lab.account,
      epoch: 'synthetic-epoch', conversation: live.conversationId, read: true, notified: false,
    }])
  })
  it('keeps an in-flight read delta through same-account capability refresh', async () => {
    const read = message('read', 2, 'u-read')
    let resolve!: (messages: Message[]) => void
    lab.getMessages.mockReturnValue(new Promise<Message[]>(done => { resolve = done }))
    lab.callback?.({ account: lab.account, kind: 'chat', conversationId: read.conversationId, pointer: makeReadPointer(read, 'chat') })
    await vi.waitFor(() => expect(lab.getMessages).toHaveBeenCalled())
    setPreviewLedgerSession({ account: lab.account, epoch: 'synthetic-epoch' })
    resolve([read])
    await vi.waitFor(() => expect(lab.invoke).toHaveBeenCalled())
  })
  it('merges only the explicitly seen row when a remote read position already lies ahead', async () => {
    const older = message('older', 1, 'u-older'), seen = message('seen', 2, 'u-seen'), later = message('later', 3, 'u-later')
    lab.messages.set(seen.conversationId, [older, seen, later])
    lab.callback?.({ account: lab.account, kind: 'chat', conversationId: seen.conversationId, pointer: makeReadPointer(seen, 'chat'), messageOnly: true })
    await vi.waitFor(() => expect(lab.invoke).toHaveBeenCalled())
    expect(lab.getMessages).not.toHaveBeenCalled()
    expect(lab.invoke.mock.calls[0][1].deltas.map((delta: { uid: string }) => delta.uid)).toEqual(['u-seen'])
  })
  it('rejects a delayed cache read after logout/account switch', async () => {
    const read = message('read', 2, 'u-read')
    let resolve!: (messages: Message[]) => void
    lab.getMessages.mockReturnValue(new Promise<Message[]>(done => { resolve = done }))
    lab.callback?.({ account: lab.account, kind: 'chat', conversationId: read.conversationId, pointer: makeReadPointer(read, 'chat') })
    await vi.waitFor(() => expect(lab.getMessages).toHaveBeenCalled())
    clearPreviewLedgerSession(); lab.account = 'other@nse.invalid'
    resolve([read]); await new Promise(done => setTimeout(done, 0))
    expect(lab.invoke).not.toHaveBeenCalled()
  })
  it('records app notifications by ID without claiming the message was read', async () => {
    const notified = message('notified', 2, 'u-notified')
    lab.messages.set(notified.conversationId, [notified])
    await reserveIOSNotification(notified.conversationId, notified.id, lab.account, 'synthetic-request')
    expect(lab.invoke.mock.calls[0][1].deltas[0]).toMatchObject({ uid: 'u-notified', notified: true, read: false })
  })
  it('rejects retracted messages before claiming', async () => {
    const original = message('deleted', 2, 'u-deleted')
    lab.messages.set(original.conversationId, [{ ...original, isRetracted: true }])
    expect(await reserveIOSNotification(original.conversationId, original.id, lab.account, 'request')).toBe(false)
    expect(lab.invoke).not.toHaveBeenCalled()
  })
  it('rejects retraction while the native reservation is pending', async () => {
    const original = message('pending', 2, 'u-pending')
    lab.messages.set(original.conversationId, [original])
    let finish!: (result: { allowed: boolean }) => void
    lab.invoke.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const reserving = postPluginNotification({ title: 'Alice', body: original.body, extra: { navType: 'conversation', navTarget: original.conversationId, messageId: original.id, accountId: lab.account } })
    await vi.waitFor(() => expect(lab.invoke).toHaveBeenCalled())
    lab.messages.set(original.conversationId, [{ ...original, isRetracted: true }])
    finish({ allowed: true })
    await reserving
    expect(lab.invoke).not.toHaveBeenCalledWith('plugin:notification|notify', expect.anything())
  })
  it('prefers a live retraction over a delayed cache lookup', async () => {
    const original = message('cached', 2, 'u-cached')
    let finish!: (value: Message) => void
    lab.getMessage.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const reserving = reserveIOSNotification(original.conversationId, original.id, lab.account, 'request')
    lab.messages.set(original.conversationId, [{ ...original, isRetracted: true }])
    finish(original)
    expect(await reserving).toBe(false)
    expect(lab.invoke).not.toHaveBeenCalled()
  })
  it('omits foreign archive IDs from claims and local reads', async () => {
    const foreign = { ...message('foreign', 2, 'foreign-id'), ownArchiveId: undefined, ownArchiveBy: 'mallory@nse.invalid' }
    lab.messages.set(foreign.conversationId, [foreign])
    expect(await reserveIOSNotification(foreign.conversationId, foreign.id, lab.account, 'request')).toBe(false)
    lab.callback?.({ account: lab.account, kind: 'chat', conversationId: foreign.conversationId, pointer: makeReadPointer(foreign, 'chat'), messageOnly: true })
    await new Promise(done => setTimeout(done, 0))
    expect(lab.invoke).not.toHaveBeenCalled()
  })
  it('does not record or claim messages without an archive ID', async () => {
    const live = message('live', 2)
    lab.messages.set(live.conversationId, [live])
    expect(await reserveIOSNotification(live.conversationId, live.id, lab.account, 'request')).toBe(false)
    lab.callback?.({ account: lab.account, kind: 'chat', conversationId: live.conversationId, pointer: makeReadPointer(live, 'chat'), messageOnly: true })
    await new Promise(done => setTimeout(done, 0))
    expect(lab.invoke).not.toHaveBeenCalled()
  })
  it('ignores MUC, other accounts and unconfirmed floor reads', async () => {
    const read = message('read', 2, 'u-read')
    const pointer = makeReadPointer(read, 'chat')
    lab.callback?.({ account: lab.account, kind: 'room', conversationId: read.conversationId, pointer })
    lab.callback?.({ account: 'other@nse.invalid', kind: 'chat', conversationId: read.conversationId, pointer })
    lab.callback?.({ account: lab.account, kind: 'chat', conversationId: read.conversationId, pointer: { ...pointer, order: { role: 'floor', timestamp: 2 } } })
    await Promise.resolve()
    expect(lab.getMessages).not.toHaveBeenCalled(); expect(lab.invoke).not.toHaveBeenCalled()
  })
})
