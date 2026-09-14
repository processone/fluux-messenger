import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory, IDBIndex } from 'fake-indexeddb'
import type { StoredMessage, StoredRoomMessage } from '../core/types/message-internal'
import { reconcileCachedCorrections, refreshCachedCorrections } from '../stores/shared/correctionHandoff'
import * as cache from './messageCache'
import { _resetStorageScopeForTesting } from './storageScope'

type Kind = 'chat' | 'room'
type Row = StoredMessage | StoredRoomMessage
const ROOM = 'refresh@conference.example.test'

function message(kind: Kind, index = 0): Row {
  const common = {
    id: `client-${index}`, stanzaId: `archive-${index}`, body: 'original',
    timestamp: new Date(1700000000000 + index), isOutgoing: false,
  }
  return kind === 'chat'
    ? { ...common, type: 'chat', conversationId: 'peer@example.test', from: 'peer@example.test' }
    : { ...common, type: 'groupchat', roomJid: ROOM, from: `${ROOM}/sender`, nick: 'sender', occupantId: 'sender' }
}

async function save(kind: Kind, rows: Row[]) {
  if (kind === 'chat') await cache.saveMessages(rows as StoredMessage[])
  else await cache.saveRoomMessages(rows as StoredRoomMessage[])
}

async function reconcile(kind: Kind, rows: Row[], resident: () => Row[] = () => []) {
  return kind === 'chat'
    ? cache.reconcileChatHistoryMessages(rows as StoredMessage[], resident as () => StoredMessage[])
    : cache.reconcileRoomHistoryMessages(rows as StoredRoomMessage[], resident as () => StoredRoomMessage[])
}

beforeEach(() => {
  _resetStorageScopeForTesting()
  cache._resetDBForTesting()
  globalThis.indexedDB = new IDBFactory()
})

afterEach(() => {
  vi.restoreAllMocks()
  cache._resetDBForTesting()
})

describe.each<Kind>(['chat', 'room'])('%s correction refresh', kind => {
  it('compares corrected rows only with identity candidates', () => {
    const rows = Array.from({ length: 256 }, (_, index) => message(kind, index))
    const tombstones = rows.map(row => ({ ...row, body: '', isRetracted: true }))
    let rowVisits = 0
    for (const row of rows) {
      const type = row.type
      Object.defineProperty(row, 'type', { enumerable: true, get() { rowVisits++; return type } })
    }

    const result = reconcileCachedCorrections(rows, tombstones, null)
    expect(result.map(row => [row.id, row.body, row.isRetracted])).toEqual(
      rows.map(row => [row.id, '', true]),
    )
    expect(rowVisits).toBeLessThanOrEqual(rows.length * 16)
  })

  it('overlaps bounded identity reads and preserves row order across batches', async () => {
    const rows = Array.from({ length: 130 }, (_, index) => message(kind, index))
    await save(kind, rows.map(row => ({ ...row, body: '', isRetracted: true })))
    const getAll = IDBIndex.prototype.getAll
    let pending = 0, peak = 0
    vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
      const request = getAll.apply(this, args)
      if (this.name === 'identityKeys') {
        peak = Math.max(peak, ++pending)
        request.addEventListener('success', () => { pending-- })
        request.addEventListener('error', () => { pending-- })
      }
      return request
    })

    const result = await reconcile(kind, rows)
    expect(result.map(row => [row.id, row.body, row.isRetracted])).toEqual(
      rows.map(row => [row.id, '', true]),
    )
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(64)
    expect(pending).toBe(0)
  })

  it('keeps unchanged arrays, rows and resident reactions after repeated refresh', async () => {
    const original = message(kind)
    await save(kind, [{ ...original, body: '', isRetracted: true }])
    const reactions = { '👍': ['viewer'] }
    const initial = [{ ...original, reactions }, message(kind, 1)]
    const first = await refreshCachedCorrections(initial, () => true)
    expect(first).not.toBe(initial)
    expect(first[0]).toMatchObject({ body: '', isRetracted: true })
    expect(first[0].reactions).toBe(reactions)
    expect(first[1]).toBe(initial[1])
    const settled = await refreshCachedCorrections(first, () => true)
    expect(await refreshCachedCorrections(settled, () => true)).toBe(settled)
    expect(settled[0].reactions).toBe(reactions)
  })

  it('rejects conflicting archive identities, authors and conversations sharing aliases', () => {
    const target = message(kind)
    const wrongArchive = { ...target, stanzaId: 'another-archive' }
    const wrongAuthor = target.type === 'chat'
      ? { ...target, from: 'another@example.test' }
      : { ...target, occupantId: 'another-occupant' }
    const wrongConversation = target.type === 'chat'
      ? { ...target, conversationId: 'another@example.test' }
      : { ...target, roomJid: 'another@conference.example.test' }
    const rows = [wrongArchive, wrongAuthor, wrongConversation, target]
    const result = reconcileCachedCorrections(rows, [{ ...target, body: '', isRetracted: true }], null)
    expect(result.slice(0, 3)).toEqual(rows.slice(0, 3))
    for (let i = 0; i < 3; i++) expect(result[i]).toBe(rows[i])
    expect(result[3]).toMatchObject({ body: '', isRetracted: true })
  })

  it.each(['stanzaId', 'originId', 'fallback'] as const)('matches all resident copies through the %s identity tier', tier => {
    const base = { ...message(kind), stanzaId: undefined, originId: undefined }
    const first = { ...base, ...(tier !== 'fallback' && { [tier]: 'shared' }) }
    const second = { ...first, ...(tier !== 'fallback' && { id: 'another-client-id' }) }
    const unrelated = { ...message(kind, 1), correctionStanzaIds: ['shared'] }
    const result = reconcileCachedCorrections([first, second, unrelated], [{ ...second, isRetracted: true }], null)
    expect(result.slice(0, 2).map(row => row.isRetracted)).toEqual([true, true])
    expect(result[2]).toBe(unrelated)
  })

  it('samples resident corrections after cache reads finish', async () => {
    const base = message(kind)
    await save(kind, [base])
    const getAll = IDBIndex.prototype.getAll
    let current = [base]
    vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
      const request = getAll.apply(this, args)
      request.addEventListener('success', () => { current = [{ ...base, body: '', isRetracted: true }] })
      return request
    })
    expect((await reconcile(kind, [base], () => current))[0]).toMatchObject({ body: '', isRetracted: true })
  })
})
