import { describe, expect, it } from 'vitest'
import { shortcutConversations, resolveShortcutURL } from './shortcutConversation'

const account = 'me@example.com'
const chats = new Map([['friend@example.com', {}]])
const rooms = new Map([['team@example.com', {}]])
const url = (owner = account, kind = 'chat', id = 'friend@example.com') =>
  `net.processone.fluux://shortcut?account=${encodeURIComponent(owner)}&kind=${kind}&id=${encodeURIComponent(id)}`

describe('Siri conversation metadata', () => {
  it('mirrors only identifiers, names, kind and owning account', () => {
    expect(shortcutConversations(account,
      [{ id: 'friend@example.com', name: 'Friend', body: 'private' } as { id: string; name: string }],
      [{ jid: 'team@example.com', name: 'Team' }],
    )).toEqual([
      { id: 'friend@example.com', name: 'Friend', kind: 'chat', account },
      { id: 'team@example.com', name: 'Team', kind: 'groupchat', account },
    ])
  })
  it('resolves existing chats and rooms without granting join or send authority', () => {
    expect(resolveShortcutURL(url(), account + '/phone', chats, rooms)).toMatchObject({ id: 'friend@example.com', kind: 'chat', account })
    expect(resolveShortcutURL(url(account, 'groupchat', 'team@example.com'), account, chats, rooms)).toMatchObject({ id: 'team@example.com', kind: 'groupchat' })
  })
  it('falls back to the conversation list for stale accounts, removed targets and malformed actions', () => {
    for (const uri of [url('old@example.com'), url(account, 'chat', 'removed@example.com'), url(account, 'send'), 'net.processone.fluux://shortcut']) {
      expect(resolveShortcutURL(uri, account, chats, rooms)).toBeNull()
    }
    expect(resolveShortcutURL(url(), null, chats, rooms)).toBeNull()
  })
  it('leaves unrelated links to their existing handlers', () => {
    expect(resolveShortcutURL('xmpp:friend@example.com?message', account, chats, rooms)).toBeUndefined()
    expect(resolveShortcutURL('https://example.com/shortcut', account, chats, rooms)).toBeUndefined()
  })
  it.each(['net.processone.fluux', 'net.processone.fluux.demo', 'net.processone.fluux.dev'])('accepts the %s build scheme', (scheme) => {
    expect(resolveShortcutURL(url().replace('net.processone.fluux:', `${scheme}:`), account, chats, rooms)).toMatchObject({ id: 'friend@example.com' })
  })
})
