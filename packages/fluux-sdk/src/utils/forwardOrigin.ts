import type { BaseMessage, FileAttachment } from '../core/types'
import { getBareJid } from '../core/jid'
import { parseRoomMessageLink, type RoomMessageLink } from './roomMessageLink'
import { getMessagesByForwardedId, getMessages, type ForwardedIdReference } from './messageCache'
import { captureStorageScope } from './storageScope'
import { messageRowRef } from './roomStanzaId'
import type { MessageRowRef } from '../core/types/messageRow'
import { forwardedCopyTextOf } from '../core/modules/messagingUtils'

/** Where the original of a forwarded copy can be opened. */
export type ForwardOrigin =
  | { kind: 'room'; roomJid: string; stanzaId: string }
  | { kind: 'chat'; conversationId: string; row: MessageRowRef }

/** How far from the copy's time a message may be and still count as the original. */
export const FORWARD_ORIGIN_WINDOW_MS = 2 * 60 * 1000

/** A copy is cut at this many characters, so only a copy this long may match a longer original by its prefix. */
const COPY_LIMIT_CHARACTERS = 4000

/**
 * The room message link the forward generated, never one pasted in the comment or quoted in the
 * source: the generated block ends with its source link, so only a link that ends the marked
 * fallback text counts, whatever order the references were rebuilt in.
 */
export function forwardedCopyRoomLink(message: Pick<BaseMessage, 'references' | 'forwarded'>): RoomMessageLink | null {
  const marked = message.forwarded?.fallback?.text?.trimEnd()
  if (!marked) return null
  for (const reference of message.references ?? []) {
    if (reference.type !== 'data' || !marked.endsWith(reference.uri)) continue
    const target = parseRoomMessageLink(reference.uri)
    if (target) return target
  }
  return null
}

/** The text a forward quotes for a file without a caption: its name, or the last part of its address. */
export function forwardedFileName(file: Pick<FileAttachment, 'name' | 'url'>): string {
  return file.name || file.url.split(/[?#]/)[0].split('/').filter(Boolean).pop() || ''
}

/**
 * Whether a received copy's text is what an honest forward of this message would carry: its body
 * or, for a file without a caption, the file's name. The name counts only when the forward carries
 * that same file, so it can never vouch for another file.
 */
export function forwardedCopyMatchesMessage(
  copyText: string,
  message: Pick<BaseMessage, 'body' | 'attachment'>,
  forwardedFile?: Pick<FileAttachment, 'url'>,
): boolean {
  const ownFile = !message.body.trim() && message.attachment?.url === forwardedFile?.url ? message.attachment : undefined
  return copyText.trim() === forwardedCopyTextOf(ownFile ? forwardedFileName(ownFile) : message.body).trim()
}

/** Exact text first; a longer original counts only for a copy that was cut at the limit, judged before trimming. */
function textMatch(body: string, copy: string): 'exact' | 'prefix' | null {
  const a = body.trim(), b = copy.trim()
  if (!b) return null
  if (a === b) return 'exact'
  return Array.from(copy).length >= COPY_LIMIT_CHARACTERS && a.startsWith(b) ? 'prefix' : null
}

/** The one closest match to the copy's time, exact text before prefix; null when none or when two tie. */
function uniqueClosest<T>(matches: readonly { row: T; kind: 'exact' | 'prefix'; at: number }[], copyTime: number | undefined): T | null {
  const best = matches.some(m => m.kind === 'exact') ? matches.filter(m => m.kind === 'exact') : matches
  if (best.length === 0) return null
  if (best.length === 1) return best[0].row
  const distance = (m: { at: number }) => copyTime === undefined ? 0 : Math.abs(m.at - copyTime)
  const sorted = [...best].sort((x, y) => distance(x) - distance(y))
  return distance(sorted[0]) === distance(sorted[1]) ? null : sorted[0].row
}

/**
 * Find the original of a forwarded copy: first the room message link the forward carries, then
 * the ids it carries, then local history by sender, time and text. Reads local history only, and
 * only when called; null when the original is not there or cannot be told from a repeat. It
 * rejects with an AbortError when the account changed while it ran.
 *
 * @param conversationIds - the direct conversations to search when the original is the account's own message
 */
export async function findForwardedOrigin(
  message: Pick<BaseMessage, 'references' | 'forwarded'>,
  account: string,
  conversationIds: readonly string[],
): Promise<ForwardOrigin | null> {
  const copy = message.forwarded
  if (!copy) return null
  const scope = captureStorageScope()
  const me = getBareJid(account)
  const link = forwardedCopyRoomLink(message)
  if (link) return { kind: 'room', ...link }

  const from = copy.from ? getBareJid(copy.from) : ''
  const isRoom = copy.type === 'groupchat'
  if (isRoom && copy.stanzaId && copy.stanzaIdBy === from) return { kind: 'room', roomJid: from, stanzaId: copy.stanzaId }
  const window = copy.timestamp !== undefined
    ? { after: new Date(copy.timestamp - FORWARD_ORIGIN_WINDOW_MS), before: new Date(copy.timestamp + FORWARD_ORIGIN_WINDOW_MS) } : undefined

  if (isRoom) {
    if (!from || !window) return null
    const slash = copy.from?.indexOf('/') ?? -1
    const nick = slash >= 0 ? copy.from!.slice(slash + 1) : copy.author
    const rows = await getMessages('room', from, window)
    scope.assertCurrent()
    const hit = uniqueClosest(rows.flatMap(row => {
      const kind = !row.isPrivate && !!row.stanzaId && row.nick === nick ? textMatch(row.body, copy.text) : null
      return kind ? [{ row, kind, at: row.timestamp.getTime() }] : []
    }), copy.timestamp)
    return hit?.stanzaId ? { kind: 'room', roomJid: from, stanzaId: hit.stanzaId } : null
  }

  // A direct copy. Another sender's messages live only in that sender's conversation; the
  // account's own originals may be in any direct conversation.
  const senderIsMe = from === me
  const candidates = senderIsMe ? [...conversationIds] : from ? [from] : []
  const valid = (row: { isOutgoing: boolean; from: string }) => senderIsMe ? row.isOutgoing : !row.isOutgoing && getBareJid(row.from) === from
  const found = (conversationId: string, row: { id: string; stanzaId?: string; originId?: string }): ForwardOrigin =>
    ({ kind: 'chat', conversationId, row: messageRowRef(row) })

  // Carried ids: the archive id when it is this account's own archive, then the sender's id.
  const references: ForwardedIdReference[] = [
    ...(copy.stanzaId && copy.stanzaIdBy === me ? [{ kind: 'own-archive' as const, id: copy.stanzaId, by: me }] : []),
    ...(copy.id ? [{ kind: 'sender-id' as const, id: copy.id }] : []),
  ]
  for (const reference of references) {
    const hits: { conversationId: string; row: Awaited<ReturnType<typeof getMessagesByForwardedId>>[number] }[] = []
    for (const conversationId of candidates) {
      for (const row of await getMessagesByForwardedId(conversationId, reference)) if (valid(row)) hits.push({ conversationId, row })
      scope.assertCurrent()
    }
    // Several rows under one id: the text tells them apart; still several, none is the original.
    const narrowed = hits.length > 1 ? hits.filter(h => textMatch(h.row.body, copy.text)) : hits
    if (narrowed.length === 1) return found(narrowed[0].conversationId, narrowed[0].row)
    if (narrowed.length > 1) return null
  }
  if (!window) return null
  const matches: { row: { id: string; stanzaId?: string; originId?: string; conversationId: string }; kind: 'exact' | 'prefix'; at: number }[] = []
  for (const conversationId of candidates) {
    const rows = await getMessages('chat', conversationId, window)
    scope.assertCurrent()
    for (const row of rows) {
      const kind = valid(row) ? textMatch(row.body, copy.text) : null
      if (kind) matches.push({ row: { id: row.id, stanzaId: row.stanzaId, originId: row.originId, conversationId }, kind, at: row.timestamp.getTime() })
    }
  }
  const hit = uniqueClosest(matches, copy.timestamp)
  return hit ? found(hit.conversationId, hit) : null
}
