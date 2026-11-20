import { describe, it, expect, beforeEach } from 'vitest'
import { savedStore, findSavedEntry, selectSavedInConversation, clearSavedLocalData } from './savedStore'
import { savedItemId } from '../utils/savedMessageKeys'
import { setStorageScopeJid } from '../utils/storageScope'
import { noteRetractedIdentity, roomRetractionAliases, _clearRetractedIdentitiesForTesting } from '../utils/retractedIdentities'
import type { SavedMessage } from '../core/types/saved'

const entry = (id: string, extra: Partial<SavedMessage> = {}): SavedMessage => ({
  id, conversationJid: 'team@conference.example', type: 'groupchat', from: 'team@conference.example/Alice',
  text: `text ${id}`, savedAt: 1000, stanzaId: `s-${id}`, stanzaIdBy: 'team@conference.example', ...extra,
})
const s = () => savedStore.getState()

describe('savedStore', () => {
  beforeEach(() => { localStorage.clear(); s().reset() })

  it('shows a save at once and keeps it pending until the server takes it', () => {
    expect(s().save(entry('a'))).toBe(true)
    expect(s().entries.a).toBeDefined()
    expect(s().pending).toEqual({ a: 'publish' })
    s().settle('a', 'publish')
    expect(s().pending).toEqual({})
  })

  it('refuses a save at the server limit and stores nothing', () => {
    s().setLimit(1)
    s().save(entry('a'))
    expect(s().save(entry('b'))).toBe(false)
    expect(Object.keys(s().entries)).toEqual(['a'])
  })

  it('removes at once and queues a retract', () => {
    s().reconcileFetch([entry('a')])
    s().remove('a')
    expect(s().entries.a).toBeUndefined()
    expect(s().pending.a).toBe('retract')
  })

  it('an answered fetch replaces the list but keeps pending local operations', () => {
    s().reconcileFetch([entry('a'), entry('b')])
    s().save(entry('c'))
    s().remove('a')
    s().reconcileFetch([entry('a'), entry('b'), entry('d')])
    expect(Object.keys(s().entries).sort()).toEqual(['b', 'c', 'd'])
  })

  it('an answered empty fetch empties the list; no fetch at all never does', () => {
    s().reconcileFetch([entry('a')])
    expect(s().loaded).toBe(true)
    // A refused or unanswered fetch makes no call into the store: the list stays.
    expect(Object.keys(s().entries)).toEqual(['a'])
    s().reconcileFetch([])
    expect(s().entries).toEqual({})
  })

  it('applies notify upserts and retracts, leaving ids with pending operations alone', () => {
    s().reconcileFetch([entry('a'), entry('b')])
    s().remove('b')
    s().applyNotify({ upserts: [entry('b'), entry('c')], removedIds: ['a'] })
    expect(Object.keys(s().entries)).toEqual(['c'])
  })

  it('shows one entry for one logical message and retracts the weaker duplicate', () => {
    const weak = entry('weak', { stanzaId: undefined, stanzaIdBy: undefined, originId: 'o1', savedAt: 5 })
    const strong = entry('strong', { originId: 'o1', savedAt: 9 })
    s().reconcileFetch([weak, strong])
    expect(Object.keys(s().entries)).toEqual(['strong'])
    expect(s().pending.weak).toBe('retract')
  })

  it('clears the text of a deleted original and republishes, keeping encrypted entries marked', () => {
    s().reconcileFetch([entry('a')])
    s().markDeleted('a')
    expect(s().entries.a.text).toBe('')
    expect(s().pending.a).toBe('publish')
  })

  it('undoes a save the server definitively refused', () => {
    s().save(entry('a'))
    s().refuse('a', 'publish')
    expect(s().entries.a).toBeUndefined()
    expect(s().refusals).toBe(1)
  })

  describe('queue kept across a reload', () => {
    const reload = () => { // a new session: memory is empty, storage stays
      const stored = { ...localStorage }
      s().reset()
      for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v)
    }
    beforeEach(() => localStorage.clear())

    it('brings back an offline save and an offline removal', () => {
      s().reconcileFetch([entry('old')])
      s().save(entry('a'))
      s().remove('old')
      reload()
      s().hydratePending()
      expect(s().pending).toEqual({ a: 'publish', old: 'retract' })
      expect(s().entries.a?.text).toBe('text a')
      expect(s().entries.old).toBeUndefined()
    })

    it('forgets the queue once the server has taken it', () => {
      s().save(entry('a'))
      s().settle('a', 'publish')
      reload()
      s().hydratePending()
      expect(s().pending).toEqual({})
      expect(Object.keys(localStorage).filter(k => k.includes('fluux-saved-pending'))).toEqual([])
    })

    it('does not overwrite the stored queue before it was read', () => {
      s().reconcileFetch([entry('b')])
      s().save(entry('a'))
      reload()
      s().reconcileFetch([entry('b')])
      s().remove('b') // acts before an explicit hydrate
      s().hydratePending()
      expect(s().pending).toMatchObject({ a: 'publish', b: 'retract' })
    })
  })
})

describe('identity of saved messages', () => {
  const room = (id: string, extra: Partial<SavedMessage> = {}): SavedMessage => entry(id, { stanzaId: undefined, stanzaIdBy: undefined, ...extra })

  it('keeps two room messages with the same sender-chosen origin id apart when their archive ids differ', () => {
    s().reset(); localStorage.clear()
    s().save(room('a', { originId: 'same', stanzaId: 'r1', stanzaIdBy: 'team@conference.example', occupantId: 'occ-a', messageId: 'm' }))
    expect(s().save(room('b', { originId: 'same', stanzaId: 'r2', stanzaIdBy: 'team@conference.example', occupantId: 'occ-b', from: 'team@conference.example/Bob', messageId: 'm' }))).toBe(true)
    expect(Object.keys(s().entries).sort()).toEqual(['a', 'b'])
    s().reconcileFetch(Object.values(s().entries))
    expect(Object.keys(s().entries).sort()).toEqual(['a', 'b'])
  })

  it('keeps a legacy entry and the same message gaining its archive id as one saved message', () => {
    s().reset(); localStorage.clear()
    const legacy = room('legacy', { originId: 'o1', messageId: 'm1', occupantId: 'occ' })
    const learned = room('learned', { originId: 'o1', messageId: 'm1', occupantId: 'occ', stanzaId: 'r1', stanzaIdBy: 'team@conference.example', savedAt: 2000 })
    s().reconcileFetch([legacy, learned])
    expect(Object.keys(s().entries)).toEqual(['learned'])
    expect(s().pending.legacy).toBe('retract')
    expect(findSavedEntry(s().entries, legacy)?.id).toBe('learned')
  })
})

describe('saved copies and the retraction ledger', () => {
  beforeEach(() => { localStorage.clear(); s().reset(); _clearRetractedIdentitiesForTesting() })
  const scope = { kind: 'room' as const, entityId: 'team@conference.example', accountScope: null }

  it('clears the text of a retracted original that is fetched, notified or hydrated after the retraction', () => {
    const note = (id: string) => noteRetractedIdentity(scope,
      roomRetractionAliases({ roomJid: scope.entityId, id: `m-${id}`, from: 'team@conference.example/Alice', stanzaId: `s-${id}`, stanzaIdBy: scope.entityId } as never),
      { from: 'team@conference.example/Alice', stanzaId: `s-${id}` }, 1)
    note('a'); note('b')
    s().reconcileFetch([entry('a')])
    expect(s().entries.a.deleted).toBe(true)
    expect(s().pending.a).toBe('publish')
    s().applyNotify({ upserts: [entry('b')], removedIds: [] })
    expect(s().entries.b?.deleted).toBe(true)
  })
})

describe('two senders sharing a client-chosen id', () => {
  beforeEach(() => { localStorage.clear(); s().reset() })

  it('keeps one-to-one messages from different authors apart when only the origin id matches', () => {
    const a = entry('a', { type: 'chat', conversationJid: 'juliet@capulet.example', from: 'juliet@capulet.example', stanzaId: undefined, stanzaIdBy: undefined, originId: 'same', messageId: 'm' })
    const b = entry('b', { type: 'chat', conversationJid: 'juliet@capulet.example', from: 'romeo@montague.example', stanzaId: undefined, stanzaIdBy: undefined, originId: 'same', messageId: 'm' })
    s().save(a)
    expect(s().save(b)).toBe(true)
    expect(Object.keys(s().entries).sort()).toEqual(['a', 'b'])
    s().reconcileFetch([a, b])
    expect(Object.keys(s().entries).sort()).toEqual(['a', 'b'])
  })
})

describe('clearSavedLocalData', () => {
  beforeEach(() => { localStorage.clear(); s().reset() })

  it('forgets the list and the stored queue of one account, or of all', () => {
    s().save(entry('a'))
    localStorage.setItem('fluux-saved-pending:other@example.com', '{"pending":{},"entries":{}}')
    clearSavedLocalData('romeo@montague.example', false)
    expect(s().entries).toEqual({})
    expect(localStorage.getItem('fluux-saved-pending:other@example.com')).not.toBeNull()
    clearSavedLocalData(null, true)
    expect(Object.keys(localStorage).filter((k) => k.startsWith('fluux-saved-pending'))).toEqual([])
  })

  it('removes the queue of the account last signed in when no account is named, as after a logout that cleared the session first', () => {
    setStorageScopeJid('romeo@montague.example')
    s().save(entry('a'))
    localStorage.setItem('fluux-saved-pending:other@example.com', '{"pending":{},"entries":{}}')
    expect(localStorage.getItem('fluux-saved-pending:romeo@montague.example')).not.toBeNull()
    clearSavedLocalData(null, false)
    setStorageScopeJid(null)
    expect(localStorage.getItem('fluux-saved-pending:romeo@montague.example')).toBeNull()
    expect(localStorage.getItem('fluux-saved-pending:other@example.com')).not.toBeNull()
  })
})

describe('a removal recovered after a reload', () => {
  beforeEach(() => { localStorage.clear(); s().reset(); _clearRetractedIdentitiesForTesting() })

  it('keeps the server copy so a refused retract brings the row back without another read', () => {
    savedStore.setState({ pending: { a: 'retract' }, hydrated: true, revisions: { a: 1 } })
    s().reconcileFetch([entry('a')])
    expect(s().entries.a).toBeUndefined()
    s().refuse('a', 'retract', 1)
    expect(s().entries.a?.text).toBe('text a')
  })
})

describe('clearing another account', () => {
  beforeEach(() => { localStorage.clear(); s().reset() })

  it('leaves the connected account\'s list and queue alone', () => {
    setStorageScopeJid('romeo@montague.example')
    s().save(entry('a'))
    localStorage.setItem('fluux-saved-pending:other@example.com', '{"pending":{},"entries":{}}')
    clearSavedLocalData('other@example.com', false)
    setStorageScopeJid(null)
    expect(s().entries.a).toBeDefined()
    expect(localStorage.getItem('fluux-saved-pending:other@example.com')).toBeNull()
  })

  describe('with OpenPGP on', () => {
    const hashed = (extra: Partial<SavedMessage> = {}) => { const e = entry('x', extra); return { ...e, id: savedItemId(e) } }

    it('gives a save a random item id instead of one derived from the message', () => {
      s().setSealState('ready')
      const e = hashed()
      s().save(e)
      const [id] = Object.keys(s().entries)
      expect(id).not.toBe(e.id)
      expect(id).toMatch(/^[0-9a-f]{32}$/)
      expect(s().pending).toEqual({ [id]: 'publish' })
    })

    it('keeps the derived id while OpenPGP is off', () => {
      const e = hashed()
      s().save(e)
      expect(Object.keys(s().entries)).toEqual([e.id])
    })

    it('moves a never-sent entry to a new id, and leaves one the server holds alone', () => {
      s().save(hashed())
      const [old] = Object.keys(s().entries)
      s().reid(old, 'fresh')
      expect(Object.keys(s().entries)).toEqual(['fresh'])
      expect(s().pending).toEqual({ fresh: 'publish' })
      s().confirm('fresh', 'publish')
      s().reid('fresh', 'other')
      expect(Object.keys(s().entries)).toEqual(['fresh'])
    })

    it('migrates an unverified entry: sealed copy under a new id first, the plain item retracted once the copy is stored', () => {
      s().setSealState('ready')
      s().reconcileFetch([entry('p', { unverified: true })])
      s().migrate('p')
      const ids = Object.keys(s().entries)
      expect(ids).toHaveLength(1)
      expect(ids[0]).not.toBe('p')
      expect(s().entries[ids[0]].unverified).toBeUndefined()
      expect(s().pending).toEqual({ [ids[0]]: 'publish' }) // the plain item is untouched meanwhile
      expect(s().remote.p).toBe(true)
      s().confirm(ids[0], 'publish')
      expect(s().pending).toEqual({ [ids[0]]: 'publish', p: 'retract' })
    })

    it('removing a sealed copy that is not stored yet removes the plain item it stands for', () => {
      s().setSealState('ready')
      s().reconcileFetch([entry('p', { unverified: true })])
      s().migrate('p')
      const [sealedId] = Object.keys(s().entries)
      s().remove(sealedId)
      expect(s().entries).toEqual({})
      expect(s().pending).toEqual({ [sealedId]: 'retract', p: 'retract' })
      expect(s().migrating).toEqual({})
    })

    it('does not migrate when the node has no free slot', () => {
      s().setSealState('ready')
      s().setLimit(1)
      s().reconcileFetch([entry('p', { unverified: true })])
      s().migrate('p')
      expect(Object.keys(s().entries)).toEqual(['p'])
      expect(s().pending).toEqual({})
    })

    it('lists the plain entry again when the sealed copy is refused, and does not list a plain item that is being sealed twice', () => {
      s().setSealState('ready')
      s().reconcileFetch([entry('p', { unverified: true })])
      s().migrate('p')
      const [sealedId] = Object.keys(s().entries)
      s().reconcileFetch([entry('p', { unverified: true })]) // a read while the copy is in flight
      expect(Object.keys(s().entries)).toEqual([sealedId])
      expect(s().pending).toEqual({ [sealedId]: 'publish' })
      s().refuse(sealedId, 'publish')
      expect(Object.keys(s().entries)).toEqual(['p'])
      expect(s().entries.p.unverified).toBe(true)
      expect(s().pending).toEqual({})
    })

    it('does not migrate a verified entry, or anything while the key is locked', () => {
      s().setSealState('ready')
      s().reconcileFetch([entry('a'), entry('u', { unverified: true })])
      s().migrate('a')
      s().setSealState('locked')
      s().migrate('u')
      expect(Object.keys(s().entries).sort()).toEqual(['a', 'u'])
      expect(s().pending).toEqual({})
    })

    it('counts locked and unlisted items as held by the server, and forgets them when the server retracts them', () => {
      s().reconcileFetch([], undefined, undefined, { locked: ['l'], rejected: ['r'] })
      expect(Object.keys(s().remote).sort()).toEqual(['l', 'r'])
      expect(Object.keys(s().lockedIds)).toEqual(['l'])
      s().applyNotify({ upserts: [], removedIds: ['l', 'r'] })
      expect(s().remote).toEqual({})
      expect(s().lockedIds).toEqual({})
    })
  })

  describe('selectSavedInConversation', () => {
    it('keeps only the entries of one conversation, newest saved first, and nothing for an unknown one', () => {
      s().save(entry('a', { savedAt: 1 }))
      s().save(entry('b', { savedAt: 3 }))
      s().save(entry('c', { savedAt: 2, conversationJid: 'emma@example.org', type: 'chat', from: 'emma@example.org' }))
      expect(selectSavedInConversation(s().entries, 'team@conference.example').map((e) => e.id)).toEqual(['b', 'a'])
      expect(selectSavedInConversation(s().entries, 'emma@example.org').map((e) => e.id)).toEqual(['c'])
      expect(selectSavedInConversation(s().entries, 'nobody@example.org')).toEqual([])
    })
  })
})
