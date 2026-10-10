import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { donateIOSConversation, startIOSShareSuggestions } from './shareSuggestions'
const fixtures = vi.hoisted(() => {
 const state = { account: 'me@example.com/phone' as string | null, rosterAccount: 'me@example.com', loaded: true,
  contacts: new Map([['friend@example.com', {}]]), rooms: new Map([['team@example.com', { joined: true }]]),
  chats: new Map([['friend@example.com', {}]]) }
 const listeners = new Set<() => void>()
 return { state, listeners, invoke: vi.fn().mockResolvedValue(undefined) }
})
vi.mock('@fluux/sdk', () => ({
 connectionStore: { getState: () => ({ jid: fixtures.state.account }) },
 rosterStore: { getState: () => ({ accountJid: fixtures.state.rosterAccount, isLoaded: fixtures.state.loaded, contacts: fixtures.state.contacts }) },
 roomStore: { getState: () => ({ rooms: fixtures.state.rooms }) },
 chatStore: { getState: () => ({ conversations: fixtures.state.chats }), subscribe: (fn: () => void) => { fixtures.listeners.add(fn); return () => fixtures.listeners.delete(fn) } },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixtures.invoke }))
let restore = () => {}
let stop = () => {}
beforeEach(() => {
 fixtures.invoke.mockClear()
 fixtures.state.account = 'me@example.com/phone'
 fixtures.state.rosterAccount = 'me@example.com'
 fixtures.state.loaded = true
 fixtures.state.chats = new Map([['friend@example.com', {}]])
 restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
})
afterEach(() => { stop(); restore() })
describe('share donation boundary', () => {
 it('donates metadata without message text for a current contact or room', async () => {
  await donateIOSConversation('me@example.com', 'friend@example.com', 'chat')
  expect(fixtures.invoke).toHaveBeenCalledWith('plugin:push|donate_conversation', { destination: { account: 'me@example.com', jid: 'friend@example.com', type: 'chat' } })
  await donateIOSConversation('me@example.com', 'team@example.com', 'groupchat')
  expect(fixtures.invoke).toHaveBeenCalledTimes(2)
 })
 it('rejects stale accounts, unloaded rosters, and removed conversations', async () => {
  await donateIOSConversation('other@example.com', 'friend@example.com', 'chat')
  await donateIOSConversation('me@example.com', 'removed@example.com', 'chat')
  fixtures.state.loaded = false
  await donateIOSConversation('me@example.com', 'friend@example.com', 'chat')
  expect(fixtures.invoke).not.toHaveBeenCalled()
 })
 it('removes a deleted conversation using the account that owned it', async () => {
  stop = startIOSShareSuggestions()
  fixtures.state.chats = new Map()
  fixtures.listeners.forEach(fn => fn())
  await vi.waitFor(() => expect(fixtures.invoke).toHaveBeenCalledWith('plugin:push|remove_conversation_donations', { destination: { account: 'me@example.com', jid: 'friend@example.com', type: 'chat' } }))
 })
 it('does not delete another account’s suggestions during store resets', async () => {
  stop = startIOSShareSuggestions()
  fixtures.state.account = 'other@example.com/phone'
  fixtures.state.chats = new Map()
  fixtures.listeners.forEach(fn => fn())
  await Promise.resolve()
  expect(fixtures.invoke).not.toHaveBeenCalled()
 })
})
