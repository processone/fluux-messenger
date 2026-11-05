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

function shortcutURL(uri: string): URL | null {
  let url: URL
  try { url = new URL(uri) } catch { return null }
  return ['net.processone.fluux:', 'net.processone.fluux.demo:', 'net.processone.fluux.dev:'].includes(url.protocol) && url.hostname === 'shortcut' ? url : null
}

/** Whether a link is one of the app's conversation shortcuts (a Siri suggestion or a Shortcuts conversation). */
export function isShortcutURL(uri: string): boolean {
  return shortcutURL(uri) !== null
}

/** Undefined leaves other schemes alone; null requests the conversation list. */
export function resolveShortcutURL(
  uri: string,
  account: string | null,
  conversations: ReadonlyMap<string, unknown>,
  rooms: ReadonlyMap<string, unknown>,
): ShortcutConversation | null | undefined {
  const url = shortcutURL(uri)
  if (!url) return undefined
  const owner = url.searchParams.get('account')
  const id = url.searchParams.get('id')
  const kind = url.searchParams.get('kind')
  if (!owner || owner !== account?.split('/')[0] || !id || (kind !== 'chat' && kind !== 'groupchat')) return null
  if (!(kind === 'chat' ? conversations : rooms).has(id)) return null
  return { id, name: id, kind, account: owner }
}
