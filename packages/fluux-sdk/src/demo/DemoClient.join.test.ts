/**
 * Demo-mode MUC join: DemoClient simulates the server by emitting join events
 * directly instead of routing a status-110 self-presence through muc.handle().
 * The real MUC.joinRoom() still creates a joinResult() deferred, so the demo
 * must settle it (via muc.confirmSimulatedJoin) — otherwise awaiting
 * joinResult() (as JoinRoomModal does) hangs forever in demo mode.
 */
import { describe, it, expect, vi } from 'vitest'
import { DemoClient } from './DemoClient'
import { roomStore } from '../stores/roomStore'

/** A DemoClient wired up enough to answer join presences. */
function makeClient() {
  const client = new DemoClient()
  ;(client as unknown as { currentJid: string | null }).currentJid = 'you@fluux.chat'
  ;(client as unknown as { selfJid: string }).selfJid = 'you@fluux.chat'
  return client
}

describe('DemoClient MUC join', () => {
  it('settles joinResult() for a simulated join (no hang)', async () => {
    const client = makeClient()

    const roomJid = 'demoroom@conference.fluux.chat'
    await client.rooms.joinRoom(roomJid, 'me')

    // If the demo failed to settle the deferred, this await would never resolve
    // and the test would hit the vitest timeout (i.e. fail loudly).
    await expect(client.rooms.joinResult(roomJid)).resolves.toBeUndefined()
  })

  // Issue #1126: the demo simulates a password-protected room so the whole
  // unlock path (401 -> prompt -> retry -> remembered) is exercisable offline.
  describe('password-protected room', () => {
    const ROOM = 'board@conference.fluux.chat'

    const seed = (client: DemoClient) => {
      ;(client as unknown as { roomPasswords: Map<string, string> }).roomPasswords.set(ROOM, 'fluux')
    }

    it('refuses a join that carries no password, as a real service does', async () => {
      const client = makeClient()
      seed(client)

      await client.rooms.joinRoom(ROOM, 'me')
      const result = client.rooms.joinResult(ROOM)

      await expect(result).rejects.toMatchObject({ condition: 'not-authorized' })
      // Not left spinning: the row must become interactive again.
      expect(roomStore.getState().getRoom(ROOM)?.isJoining).toBe(false)
    })

    it('refuses a wrong password', async () => {
      const client = makeClient()
      seed(client)

      await client.rooms.joinRoom(ROOM, 'me', { password: 'nope' })

      await expect(client.rooms.joinResult(ROOM)).rejects.toMatchObject({ condition: 'not-authorized' })
    })

    it('accepts the right password and remembers it for the next join', async () => {
      const client = makeClient()
      seed(client)

      await client.rooms.joinRoom(ROOM, 'me', { password: 'fluux' })
      await expect(client.rooms.joinResult(ROOM)).resolves.toBeUndefined()

      // The password that worked is now on the room, so a rejoin needs no prompt.
      await vi.waitFor(() => expect(roomStore.getState().getRoom(ROOM)?.password).toBe('fluux'))

      await client.rooms.leaveRoom(ROOM)
      await client.rooms.joinRoom(ROOM, 'me')
      await expect(client.rooms.joinResult(ROOM)).resolves.toBeUndefined()
    })
  })
})
