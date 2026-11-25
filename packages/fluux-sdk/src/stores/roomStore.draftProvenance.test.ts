import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { roomStore } from './roomStore'
import { setStorageScopeJid, _resetStorageScopeForTesting } from '../utils/storageScope'
import { flush, _resetForTesting } from './shared/throttledStorage'

const ACCOUNT = 'alice@example.test'
const OTHER_ACCOUNT = 'bob@example.test'
const ROOM = 'design@conference.example.test'
const TEXT = 'Please keep the staffing discussion between us.'
const key = (account: string) => `fluux-room-drafts:${account}`

beforeEach(() => {
  _resetForTesting()
  _resetStorageScopeForTesting()
  localStorage.clear()
  roomStore.getState().reset()
  setStorageScopeJid(ACCOUNT)
  roomStore.getState().switchAccount(ACCOUNT)
})

afterEach(() => {
  _resetForTesting()
  localStorage.clear()
  _resetStorageScopeForTesting()
})

describe('room draft provenance across upgrades', () => {
  it('owns the legacy upgrade rule: preserve untyped text without qualifying an unchanged save', () => {
    localStorage.setItem(key(ACCOUNT), JSON.stringify([[ROOM, TEXT]]))
    roomStore.getState().switchAccount(ACCOUNT)
    expect(roomStore.getState().getDraft(ROOM)).toBe(TEXT)
    expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(false)
    roomStore.getState().setDraft(ROOM, TEXT)
    flush()
    expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(false)
    expect(JSON.parse(localStorage.getItem(key(ACCOUNT))!)).toEqual([[ROOM, TEXT]])
  })

  it('owns the compatible public marker and its restart, replacement and removal behavior', () => {
    const text = 'The public review starts on Thursday.'
    roomStore.getState().setDraft(ROOM, text, { ordinary: true })
    flush()
    const stored = localStorage.getItem(key(ACCOUNT))!
    expect(JSON.parse(stored)).toEqual([[ROOM, text, 'public']])
    expect(new Map<string, string>(JSON.parse(stored)).get(ROOM)).toBe(text)
    roomStore.getState().switchAccount(ACCOUNT)
    expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(true)
    expect(roomStore.getState().getDraft(ROOM)).toBe(text)
    roomStore.getState().setDraft(ROOM, TEXT)
    expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(false)
    roomStore.getState().setDraft(ROOM, text, { ordinary: true })
    roomStore.getState().clearDraft(ROOM)
    flush()
    expect(roomStore.getState().getDraft(ROOM)).toBe('')
    expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(false)
    expect(JSON.parse(localStorage.getItem(key(ACCOUNT))!)).toEqual([])
  })

  it('owns downgrade safety: lost or unknown markers withhold text without deleting it', () => {
    for (const entry of [[ROOM, TEXT], [ROOM, TEXT, 'unrecognized-origin']]) {
      roomStore.getState().setDraft(ROOM, TEXT, { ordinary: true })
      flush()
      localStorage.setItem(key(ACCOUNT), JSON.stringify([entry]))
      roomStore.getState().switchAccount(ACCOUNT)
      expect(roomStore.getState().getDraft(ROOM)).toBe(TEXT)
      expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(false)
    }
  })

  it('binds qualification to the final record selected by the Map reader', () => {
    roomStore.getState().setDraft(ROOM, 'An earlier public agenda.', { ordinary: true })
    flush()
    const earlierEntries = JSON.parse(localStorage.getItem(key(ACCOUNT))!)
    localStorage.setItem(key(ACCOUNT), JSON.stringify([...earlierEntries, [ROOM, TEXT]]))
    roomStore.getState().switchAccount(ACCOUNT)
    expect(roomStore.getState().getDraft(ROOM)).toBe(TEXT)
    expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(false)
  })

  it('owns account isolation and reset of public qualification', () => {
    roomStore.getState().setDraft(ROOM, 'Public agenda for Alice.', { ordinary: true })
    flush()
    localStorage.setItem(key(OTHER_ACCOUNT), JSON.stringify([[ROOM, TEXT]]))
    setStorageScopeJid(OTHER_ACCOUNT)
    roomStore.getState().switchAccount(OTHER_ACCOUNT)
    expect(roomStore.getState().getDraft(ROOM)).toBe(TEXT)
    expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(false)
    setStorageScopeJid(ACCOUNT)
    roomStore.getState().switchAccount(ACCOUNT)
    expect(roomStore.getState().getDraft(ROOM)).toBe('Public agenda for Alice.')
    expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(true)
    roomStore.getState().reset()
    expect(roomStore.getState().ordinaryDrafts.size).toBe(0)
    expect(roomStore.getState().getDraft(ROOM)).toBe('')
    expect(localStorage.getItem(key(OTHER_ACCOUNT))).toBe(JSON.stringify([[ROOM, TEXT]]))
  })
})
