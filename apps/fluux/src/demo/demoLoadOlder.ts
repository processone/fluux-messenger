/**
 * Demo "load older messages" (MAM scroll-up) support.
 *
 * The real client answers `fetchOlderHistory` by querying MAM and prepending the result
 * via `roomStore.mergeRoomMAMMessages(..., 'backward')`. The demo has no server, so we
 * patch `client.chat.queryRoomMAM` to synthesize a batch of OLDER messages on demand and
 * feed them through the exact same store path. This makes scroll-up actually prepend in
 * demo mode — needed to exercise the prepend-anchor scroll restore (and, with
 * virtualization, to reproduce/verify the anchor behavior on a real layout engine).
 *
 * Gated to `stress-*` rooms so the curated demo rooms keep their finite history.
 */
import type { RoomMessage } from '@fluux/sdk'
import { roomStore } from '@fluux/sdk/stores'

/** Total synthetic older messages available per stress room before history is "complete". */
const MAX_OLDER_PER_ROOM = 400
const BATCH = 50

/** Build a batch of messages strictly older than `oldest`, in chronological order, with
 *  deliberately varied heights (every 4th wraps to several lines) so the virtualizer's
 *  constant size estimate diverges from measured — which is what surfaces a prepend jump. */
function buildOlderBatch(roomJid: string, oldest: RoomMessage, startIdx: number, count: number): RoomMessage[] {
  const roomIdx = roomJid.match(/stress-(\d+)/)?.[1] ?? '0'
  const baseTs = oldest.timestamp.getTime()
  const batch: RoomMessage[] = []
  for (let k = 0; k < count; k++) {
    const idx = startIdx + k
    const nick = `U${roomIdx}_${idx % 8}`
    const tall = idx % 4 === 0
    const body = tall
      ? `older message ${idx} — intentionally long so it wraps across several lines and measures much ` +
        `taller than the size estimate. That height variance is exactly what makes a prepend-anchor ` +
        `jump visible. More text on the next line. And a third line to be sure it wraps.`
      : `older message ${idx}`
    batch.push({
      type: 'groupchat',
      // Strictly older than `oldest`, chronological within the batch (k=0 is the oldest).
      timestamp: new Date(baseTs - (count - k) * 60_000),
      id: `${roomJid}::older-${idx}`,
      from: `${roomJid}/${nick}`,
      nick,
      body,
      isOutgoing: false,
      roomJid,
    })
  }
  return batch
}

type MAMable = { chat: { queryRoomMAM: (opts: { roomJid: string; before?: string }) => Promise<unknown> } }

/** Patch the demo client so MAM scroll-up prepends synthetic older messages (stress rooms). */
export function installDemoLoadOlder(client: MAMable): void {
  const generated = new Map<string, number>()

  client.chat.queryRoomMAM = async ({ roomJid }) => {
    const rs = roomStore.getState()
    // Non-stress (curated) rooms have finite history — report complete immediately.
    if (!roomJid.startsWith('stress-')) {
      rs.mergeRoomMAMMessages(roomJid, [], { count: 0 }, true, 'backward')
      return { messages: [], complete: true }
    }

    // Mimic a network round-trip so the prepend lands asynchronously, as in production.
    await new Promise((r) => setTimeout(r, 80))

    const oldest = rs.getRoom(roomJid)?.messages?.[0]
    const start = generated.get(roomJid) ?? 0
    if (!oldest || start >= MAX_OLDER_PER_ROOM) {
      rs.mergeRoomMAMMessages(roomJid, [], { count: 0 }, true, 'backward')
      return { messages: [], complete: true }
    }

    const count = Math.min(BATCH, MAX_OLDER_PER_ROOM - start)
    const batch = buildOlderBatch(roomJid, oldest, start, count)
    generated.set(roomJid, start + count)
    const complete = start + count >= MAX_OLDER_PER_ROOM
    rs.mergeRoomMAMMessages(
      roomJid,
      batch,
      { first: batch[0].id, last: batch[batch.length - 1].id, count: batch.length },
      complete,
      'backward',
    )
    return { messages: batch, complete }
  }
}
