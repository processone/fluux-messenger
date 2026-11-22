import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoredMessage, StoredRoomMessage } from '../core/types/message-internal'
import { correctionContent } from '../core/types/message-internal'
import { reconcileCorrectionHandoff } from '../stores/shared/correctionHandoff'
import { retractChatMessageInStorage, retractRoomMessageInStorage } from '../stores/shared/retractionStorage'
import * as cache from './messageCache'
import * as searchIndex from './searchIndex'
import { setStorageScopeJid } from './storageScope'
import { _clearRetractedIdentitiesForTesting } from './retractedIdentities'
import { buildRoomMessageLink } from './roomMessageLink'
import { subscribeMessageCacheUpdates } from './messageCacheUpdates'

const account = 'alice@example.org'
const peer = 'bob@example.org'
const room = 'project@conference.example.org'
const linkA = buildRoomMessageLink('team@conference.example.org', '1731490000123456')
const linkB = buildRoomMessageLink('team@conference.example.org', '550e8400-e29b-41d4-a716-446655440000')
type Kind = 'chat' | 'room'
type Row = StoredMessage | StoredRoomMessage
const references = (uri: string) => [{ type: 'data' as const, uri }]
function original(kind: Kind): Row {
  const common = { id: 'shared-room-link', stanzaId: '1731490000123500', originId: 'shared-room-link',
    body: linkA, references: references(linkA), timestamp: new Date('2026-05-01T10:00:00Z'), isOutgoing: false }
  return kind === 'chat' ? { ...common, type: 'chat', from: peer, conversationId: peer }
    : { ...common, type: 'groupchat', from: `${room}/Bob`, roomJid: room, nick: 'Bob', occupantId: 'bob' }
}
async function save(row: Row) {
  if (row.type === 'chat') await cache.saveMessage('chat', row)
  else await cache.saveMessage('room', row)
}
async function reload(kind: Kind): Promise<Row> {
  cache._resetDBForTesting()
  const rows = kind === 'chat' ? await cache.getMessages('chat', peer) : await cache.getMessages('room', room)
  expect(rows).toHaveLength(1)
  return rows[0]
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  cache._resetDBForTesting()
  searchIndex._resetDBForTesting()
  _clearRetractedIdentitiesForTesting()
  setStorageScopeJid(account)
})
afterEach(() => { setStorageScopeJid(null); _clearRetractedIdentitiesForTesting() })

// Approved room-link sharing: references belong to the displayed content revision,
// and deleting that shared content erases the link from durable copies as well.
// The real cache, correction handoff and retraction sink own these transitions;
// fake IndexedDB replaces storage only, not content-selection behavior.
describe.each<Kind>(['chat', 'room'])('%s shared-link content ownership', kind => {
  it.each([linkB, undefined])('keeps or clears the winning edit reference through replay, hydration and handoff: %s', async uri => {
    const first = original(kind)
    const update = { body: uri ?? 'Please disregard the link.', references: uri ? references(uri) : undefined,
      isEdited: true as const, correctionTimestamp: Date.parse('2026-05-01T10:01:00Z'), correctionTimestampSource: 'delay' as const,
      correctionRevision: { ids: ['origin:revised-room-link'], supersedes: [] } }
    await save(first)
    if (kind === 'chat') await cache.updateMessage('chat', peer, first.id, update, first.from)
    else await cache.updateMessage('room', room, first.id, update, first.from)
    const edited = await reload(kind)
    expect(edited.body).toBe(update.body)
    expect(correctionContent(edited).references).toEqual(update.references)
    const history = kind === 'chat'
      ? await cache.reconcileHistoryMessages('chat', [first as StoredMessage], () => [], account)
      : await cache.reconcileHistoryMessages('room', [first as StoredRoomMessage], () => [], account)
    expect(history[0]).toMatchObject({ body: update.body, references: update.references })
    expect(reconcileCorrectionHandoff(first, edited, account)).toMatchObject({ body: update.body, references: update.references })
    await save(first)
    expect(await reload(kind)).toMatchObject({ body: update.body, references: update.references })
  })

  it('notifies readers with the committed correction content, not a new arrival', async () => {
    const first = original(kind)
    await save(first)
    const committed: Row[] = []
    const unsubscribe = subscribeMessageCacheUpdates(event => {
      if (event.account === account && event.kind === kind) committed.push(event.target)
    })
    try {
      const updates = correctionContent({ body: linkB, references: references(linkB), isEdited: true })
      if (first.type === 'chat') await cache.applyCorrection('chat', peer, first.id, updates, { actorJid: first.from })
      else await cache.applyCorrection('room', room, first.id, updates, { actorJid: first.from, actorOccupantId: first.occupantId })
      expect(committed.at(-1)).toMatchObject({ body: linkB, references: references(linkB) })
      expect(await reload(kind)).toMatchObject({ body: committed.at(-1)!.body, references: committed.at(-1)!.references })
    } finally { unsubscribe() }
  })

  it('erases the shared reference on deletion, cache reload and original redelivery', async () => {
    const first = original(kind)
    await save(first)
    if (first.type === 'chat') await retractChatMessageInStorage(peer, first)
    else await retractRoomMessageInStorage(room, first)
    expect(await reload(kind)).toMatchObject({ isRetracted: true, body: '', references: undefined })
    const deletionSignals: Row[] = []
    const unsubscribe = subscribeMessageCacheUpdates(event => {
      if (event.account === account && event.kind === kind) deletionSignals.push(event.target)
    })
    try {
      const stale = { body: linkB, references: references(linkB) }
      if (first.type === 'chat') await cache.updateMessage('chat', peer, first.id, stale, first.from)
      else await cache.updateMessage('room', room, first.id, stale, first.from)
      expect(deletionSignals.at(-1)).toMatchObject({ isRetracted: true, body: '', references: undefined })
    } finally { unsubscribe() }
    const deleted = await reload(kind)
    expect(reconcileCorrectionHandoff(first, deleted, account)).toMatchObject({ isRetracted: true, references: undefined })
    await save(first)
    expect(await reload(kind)).toMatchObject({ isRetracted: true, body: '', references: undefined })
  })
})
