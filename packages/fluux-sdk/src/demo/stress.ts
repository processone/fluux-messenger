import type { Room, RoomMessage, RoomOccupant } from '../core/types/room'

export interface StressScenario {
  kind: 'room-join'
  rooms?: number
  occupants?: number
  messagesPerRoom?: number
  mode?: 'backfill' | 'live'
  roomStepMs?: number
  msgStepMs?: number
}

export type StressEvent =
  | { delayMs: number; type: 'room:added';           payload: { room: Room } }
  | { delayMs: number; type: 'room:joined';          payload: { roomJid: string; joined: boolean } }
  | { delayMs: number; type: 'room:self-occupant';   payload: { roomJid: string; occupant: RoomOccupant } }
  | { delayMs: number; type: 'room:occupants-batch'; payload: { roomJid: string; occupants: RoomOccupant[] } }
  | { delayMs: number; type: 'room:message';         payload: { roomJid: string; message: RoomMessage } }

export interface StressContext {
  selfJid: string
  selfNick: string
  conferenceService: string
}

// Fixed epoch base so backfill ordering is deterministic and never "now".
const BASE_TS = 1577836800000 // 2020-01-01T00:00:00Z
// Each room is placed one minute earlier so rooms never share timestamps.
const MS_PER_MINUTE = 60_000

export function buildStressEvents(scenario: StressScenario, ctx: StressContext): StressEvent[] {
  const rooms = scenario.rooms ?? 15
  const occupants = scenario.occupants ?? 60
  // Guard against 0 so message nick math is valid.
  const occ = Math.max(1, occupants)
  const messagesPerRoom = scenario.messagesPerRoom ?? 30
  const mode = scenario.mode ?? 'backfill'
  const roomStepMs = scenario.roomStepMs ?? 50
  const msgStepMs = scenario.msgStepMs ?? 10
  const domain = ctx.selfJid.split('@')[1] ?? 'fluux.chat'

  const events: StressEvent[] = []
  let globalMsg = 0
  for (let i = 0; i < rooms; i++) {
    const base = i * roomStepMs
    const roomJid = `stress-${i}@${ctx.conferenceService}`
    const room: Room = {
      jid: roomJid, name: `Stress ${i}`, nickname: ctx.selfNick, joined: true,
      isBookmarked: false, autojoin: false, supportsMAM: true, supportsReactions: true,
      unreadCount: 0, mentionsCount: 0, typingUsers: new Set(), occupants: new Map(), messages: [],
    }
    const selfOcc: RoomOccupant = { nick: ctx.selfNick, jid: ctx.selfJid, affiliation: 'owner', role: 'moderator' }
    events.push({ delayMs: base, type: 'room:added', payload: { room } })
    events.push({ delayMs: base, type: 'room:joined', payload: { roomJid, joined: true } })
    events.push({ delayMs: base, type: 'room:self-occupant', payload: { roomJid, occupant: selfOcc } })
    const occList: RoomOccupant[] = [selfOcc]
    for (let k = 0; k < occ; k++) {
      occList.push({ nick: `U${i}_${k}`, jid: `u${i}_${k}@${domain}`, affiliation: 'member', role: 'participant' })
    }
    events.push({ delayMs: base, type: 'room:occupants-batch', payload: { roomJid, occupants: occList } })
    for (let m = 0; m < messagesPerRoom; m++) {
      // backfill: fixed, distinct-per-room, older for later rooms -> no reorder.
      // live: globally increasing -> each message becomes newest -> reorders.
      const ts = mode === 'backfill' ? BASE_TS - i * MS_PER_MINUTE : BASE_TS + globalMsg + 1
      const nick = `U${i}_${m % occ}`
      const message: RoomMessage = {
        type: 'groupchat', id: `stress-${i}-${m}`, from: `${roomJid}/${nick}`, nick,
        body: `stress message ${m}`, timestamp: new Date(ts), isOutgoing: false, roomJid,
        // XEP-0359 archive id: MDS (XEP-0490) markers match on stanzaId, so
        // stress backlogs must carry one to exercise read-sync flows in demo.
        stanzaId: `sid-stress-${i}-${m}`,
      }
      events.push({ delayMs: base + 20 + m * msgStepMs, type: 'room:message', payload: { roomJid, message } })
      globalMsg++
    }
  }
  return events
}
