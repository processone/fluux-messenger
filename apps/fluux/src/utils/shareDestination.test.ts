import { describe, expect, it } from 'vitest'
import { resolveShareDestination, type ShareDestination } from './shareInbox'
const account = 'me@example.com'
const contacts = new Map([['friend@example.com', { name: 'Friend' }]])
const rooms = new Map([['team@conference.example.com', { name: 'Team', joined: true, selfOccupant: { role: 'participant' } }]])
const suggestion: ShareDestination = { account, jid: 'friend@example.com', type: 'chat' }
const resolve = (value = suggestion, owner: string | null = account, roster: string | null = account) => resolveShareDestination(value, owner, roster, contacts, rooms)
describe('account-bound share suggestions', () => {
  it('resolves a current roster contact for confirmation', () => expect(resolve()).toEqual({ ...suggestion, name: 'Friend' }))
  it('resolves a joined room with send permission', () => expect(resolve({ account, jid: 'team@conference.example.com', type: 'groupchat' })?.name).toBe('Team'))
  it('rejects another account, a stale roster, and removed contacts', () => {
    expect(resolve(suggestion, 'other@example.com')).toBeNull()
    expect(resolve(suggestion, account, 'other@example.com')).toBeNull()
    expect(resolve({ ...suggestion, jid: 'gone@example.com' })).toBeNull()
    expect(resolve(suggestion, null)).toBeNull()
  })
  it('rejects departed and visitor rooms', () => {
    for (const room of [{ name: 'Team', joined: false }, { name: 'Team', joined: true, selfOccupant: { role: 'visitor' } }]) {
      expect(resolveShareDestination({ account, jid: 'room@example.com', type: 'groupchat' }, account, account, contacts, new Map([['room@example.com', room]]))).toBeNull()
    }
  })
})
