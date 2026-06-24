/**
 * Demo "load older messages" (MAM scroll-up) support for rooms AND 1:1 chats.
 *
 * The real client answers `fetchOlderHistory` by querying MAM and prepending the result
 * via `roomStore.mergeRoomMAMMessages` / `chatStore.mergeMAMMessages` ('backward'). The
 * demo has no server, so we patch `client.chat.queryRoomMAM` (rooms) and `client.chat.queryMAM`
 * (1:1) to synthesize a batch of OLDER messages on demand and feed them through the exact
 * same store path. This makes scroll-up actually prepend in demo mode — needed to exercise
 * the prepend-anchor scroll restore (and verify it on a real engine).
 *
 * Gated to `stress-*` rooms and the `stress-contact` 1:1 so curated demo conversations keep
 * their finite history. `seedStressConversation()` seeds an immediately-virtualized 1:1.
 */
import type { RoomMessage, Message, Conversation } from '@fluux/sdk'
import { roomStore, chatStore } from '@fluux/sdk/stores'

/** Total synthetic older messages available per conversation before history is "complete". */
const MAX_OLDER = 400
const BATCH = 50
const STRESS_CONTACT_JID = 'stress-contact@fluux.chat'
const SELF_JID = 'you@fluux.chat'

/** A body that is deliberately tall every 4th message, so the virtualizer's size estimate
 *  diverges from measured — the height variance is what makes a prepend-anchor jump visible. */
function bodyFor(idx: number): string {
  return idx % 4 === 0
    ? `older message ${idx} — intentionally long so it wraps across several lines and measures much ` +
      `taller than the size estimate. That height variance is exactly what makes a prepend-anchor ` +
      `jump visible. More text on the next line. And a third line to be sure it wraps.`
    : `older message ${idx}`
}

/** Build older RoomMessages (strictly older than `oldest`, chronological within the batch). */
function buildOlderRoomBatch(roomJid: string, oldest: RoomMessage, startIdx: number, count: number): RoomMessage[] {
  const roomIdx = roomJid.match(/stress-(\d+)/)?.[1] ?? '0'
  const baseTs = oldest.timestamp.getTime()
  return Array.from({ length: count }, (_, k) => {
    const idx = startIdx + k
    const nick = `U${roomIdx}_${idx % 8}`
    return {
      type: 'groupchat' as const,
      timestamp: new Date(baseTs - (count - k) * 60_000),
      id: `${roomJid}::older-${idx}`,
      from: `${roomJid}/${nick}`,
      nick,
      body: bodyFor(idx),
      isOutgoing: false,
      roomJid,
    }
  })
}

/** Build older 1:1 Messages (strictly older than `oldest`, chronological within the batch). */
function buildOlderChatBatch(conversationId: string, oldest: Message, startIdx: number, count: number): Message[] {
  const baseTs = oldest.timestamp.getTime()
  return Array.from({ length: count }, (_, k) => {
    const idx = startIdx + k
    const outgoing = idx % 7 === 0
    return {
      type: 'chat' as const,
      conversationId,
      timestamp: new Date(baseTs - (count - k) * 60_000),
      id: `${conversationId}::older-${idx}`,
      from: outgoing ? SELF_JID : conversationId,
      body: bodyFor(idx),
      isOutgoing: outgoing,
    }
  })
}

type MAMable = {
  chat: {
    queryRoomMAM: (opts: { roomJid: string; before?: string }) => Promise<unknown>
    queryMAM: (opts: { with: string; before?: string }) => Promise<unknown>
  }
}

/** Patch the demo client so MAM scroll-up prepends synthetic older messages
 *  (stress-* rooms and the stress-contact 1:1). */
export function installDemoLoadOlder(client: MAMable): void {
  const roomGenerated = new Map<string, number>()
  const chatGenerated = new Map<string, number>()

  client.chat.queryRoomMAM = async ({ roomJid }) => {
    const rs = roomStore.getState()
    if (!roomJid.startsWith('stress-')) {
      rs.mergeRoomMAMMessages(roomJid, [], { count: 0 }, true, 'backward')
      return { messages: [], complete: true }
    }
    await new Promise((r) => setTimeout(r, 80)) // mimic a network round-trip
    const oldest = rs.getRoom(roomJid)?.messages?.[0]
    const start = roomGenerated.get(roomJid) ?? 0
    if (!oldest || start >= MAX_OLDER) {
      rs.mergeRoomMAMMessages(roomJid, [], { count: 0 }, true, 'backward')
      return { messages: [], complete: true }
    }
    const count = Math.min(BATCH, MAX_OLDER - start)
    const batch = buildOlderRoomBatch(roomJid, oldest, start, count)
    roomGenerated.set(roomJid, start + count)
    const complete = start + count >= MAX_OLDER
    rs.mergeRoomMAMMessages(roomJid, batch, { first: batch[0].id, last: batch[batch.length - 1].id, count: batch.length }, complete, 'backward')
    return { messages: batch, complete }
  }

  client.chat.queryMAM = async ({ with: jid }) => {
    const cs = chatStore.getState()
    if (!jid.startsWith('stress-')) {
      cs.mergeMAMMessages(jid, [], { count: 0 }, true, 'backward')
      return { messages: [], complete: true }
    }
    await new Promise((r) => setTimeout(r, 80))
    const oldest = cs.messages.get(jid)?.[0]
    const start = chatGenerated.get(jid) ?? 0
    if (!oldest || start >= MAX_OLDER) {
      cs.mergeMAMMessages(jid, [], { count: 0 }, true, 'backward')
      return { messages: [], complete: true }
    }
    const count = Math.min(BATCH, MAX_OLDER - start)
    const batch = buildOlderChatBatch(jid, oldest, start, count)
    chatGenerated.set(jid, start + count)
    const complete = start + count >= MAX_OLDER
    cs.mergeMAMMessages(jid, batch, { first: batch[0].id, last: batch[batch.length - 1].id, count: batch.length }, complete, 'backward')
    return { messages: batch, complete }
  }
}

/** Seed an immediately-virtualized stress 1:1 conversation with `messageCount` messages, so
 *  the prepend-anchor restore can be tested in 1:1 chats (parallel to the stress room).
 *  Returns the conversation JID. */
export function seedStressConversation(messageCount: number): string {
  const cs = chatStore.getState()
  const conv: Conversation = { id: STRESS_CONTACT_JID, name: 'Stress Contact', type: 'chat', unreadCount: 0 }
  cs.addConversation(conv)
  const baseTs = Date.now() - messageCount * 60_000
  const seed: Message[] = Array.from({ length: messageCount }, (_, i) => {
    const outgoing = i % 7 === 0
    return {
      type: 'chat' as const,
      conversationId: STRESS_CONTACT_JID,
      timestamp: new Date(baseTs + i * 60_000),
      id: `${STRESS_CONTACT_JID}::seed-${i}`,
      from: outgoing ? SELF_JID : STRESS_CONTACT_JID,
      body: i % 5 === 0 ? `seed message ${i} — a longer one that wraps onto a second line for height variance.` : `seed message ${i}`,
      isOutgoing: outgoing,
    }
  })
  // 'backward' merge into the empty conversation = the seed, with history left incomplete so
  // scroll-up keeps loading synthetic older messages.
  cs.mergeMAMMessages(STRESS_CONTACT_JID, seed, { first: seed[0]?.id, last: seed[seed.length - 1]?.id, count: seed.length }, false, 'backward')
  return STRESS_CONTACT_JID
}
