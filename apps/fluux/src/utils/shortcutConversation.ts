export interface ShortcutConversation {
  id: string
  name: string
  kind: 'chat' | 'groupchat'
  account: string
}

export function shortcutConversations(
  account: string,
  chats: Iterable<{ id: string; name: string }>,
  rooms: Iterable<{ jid: string; name: string }>,
): ShortcutConversation[] {
  return [
    ...Array.from(chats, ({ id, name }) => ({ id, name: name || id, kind: 'chat' as const, account })),
    ...Array.from(rooms, ({ jid, name }) => ({ id: jid, name: name || jid, kind: 'groupchat' as const, account })),
  ]
}

/** Undefined leaves other schemes alone; null requests the conversation list. */
export function resolveShortcutURL(
  uri: string,
  account: string | null,
  conversations: ReadonlyMap<string, unknown>,
  rooms: ReadonlyMap<string, unknown>,
): ShortcutConversation | null | undefined {
  let url: URL
  try { url = new URL(uri) } catch { return undefined }
  if (!['net.processone.fluux:', 'net.processone.fluux.demo:', 'net.processone.fluux.dev:'].includes(url.protocol) || url.hostname !== 'shortcut') return undefined
  const owner = url.searchParams.get('account')
  const id = url.searchParams.get('id')
  const kind = url.searchParams.get('kind')
  if (!owner || owner !== account?.split('/')[0] || !id || (kind !== 'chat' && kind !== 'groupchat')) return null
  if (!(kind === 'chat' ? conversations : rooms).has(id)) return null
  return { id, name: id, kind, account: owner }
}
