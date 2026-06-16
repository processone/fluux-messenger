/**
 * Demo-mode MUC join: DemoClient simulates the server by emitting join events
 * directly instead of routing a status-110 self-presence through muc.handle().
 * The real MUC.joinRoom() still creates a joinResult() deferred, so the demo
 * must settle it (via muc.confirmSimulatedJoin) — otherwise awaiting
 * joinResult() (as JoinRoomModal does) hangs forever in demo mode.
 */
import { describe, it, expect } from 'vitest'
import { DemoClient } from './DemoClient'

describe('DemoClient MUC join', () => {
  it('settles joinResult() for a simulated join (no hang)', async () => {
    const client = new DemoClient()
    ;(client as unknown as { currentJid: string | null }).currentJid = 'you@fluux.chat'
    ;(client as unknown as { selfJid: string }).selfJid = 'you@fluux.chat'

    const roomJid = 'demoroom@conference.fluux.chat'
    await client.muc.joinRoom(roomJid, 'me')

    // If the demo failed to settle the deferred, this await would never resolve
    // and the test would hit the vitest timeout (i.e. fail loudly).
    await expect(client.muc.joinResult(roomJid)).resolves.toBeUndefined()
  })
})
