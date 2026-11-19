import { describe, it, expect, beforeEach } from 'vitest'
import { savedStore } from './savedStore'
import type { SavedMessage } from '../core/types/saved'

const entry = (id: string, extra: Partial<SavedMessage> = {}): SavedMessage => ({
  id, conversationJid: 'team@conference.example', type: 'groupchat', from: 'team@conference.example/Alice',
  text: `text ${id}`, savedAt: 1000, stanzaId: `s-${id}`, stanzaIdBy: 'team@conference.example', ...extra,
})
const s = () => savedStore.getState()

describe('savedStore', () => {
  beforeEach(() => s().reset())

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
})
