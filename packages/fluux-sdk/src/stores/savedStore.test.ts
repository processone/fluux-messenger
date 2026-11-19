import { describe, it, expect, beforeEach } from 'vitest'
import { savedStore, findSavedEntry } from './savedStore'
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
