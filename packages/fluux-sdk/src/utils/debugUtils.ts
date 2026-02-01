/**
 * Debug utilities exposed on window.__FLUUX_DEBUG__ for troubleshooting.
 *
 * These utilities are available in the browser console when the app is running.
 *
 * @example
 * ```javascript
 * // Catch up last 7 days of messages for all joined rooms
 * window.__FLUUX_DEBUG__.catchupAllRooms()
 *
 * // Catch up last 14 days
 * window.__FLUUX_DEBUG__.catchupAllRooms(14)
 *
 * // Get XMPPClient instance
 * window.__FLUUX_DEBUG__.getClient()
 *
 * // Get room store state
 * window.__FLUUX_DEBUG__.getRooms()
 * ```
 *
 * @module Utils/DebugUtils
 */

import type { XMPPClient } from '../core/XMPPClient'
import { roomStore } from '../stores/roomStore'
import { connectionStore } from '../stores/connectionStore'

/**
 * Debug utilities interface exposed on window.__FLUUX_DEBUG__
 */
export interface FluuxDebugUtils {
  /** Catch up MAM history for all joined rooms */
  catchupAllRooms: (daysBack?: number) => Promise<void>
  /** Get the XMPPClient instance */
  getClient: () => XMPPClient
  /** Get room store state */
  getRooms: () => ReturnType<typeof roomStore.getState>['rooms']
}

declare global {
  interface Window {
    __FLUUX_DEBUG__?: FluuxDebugUtils
  }
}

/**
 * Create debug utilities object for the given client.
 */
function createDebugUtils(client: XMPPClient): FluuxDebugUtils {
  return {
    /**
     * Catch up MAM history for all joined rooms (last N days).
     * Usage: window.__FLUUX_DEBUG__.catchupAllRooms()
     */
    catchupAllRooms: async (daysBack = 7) => {
      const rooms = roomStore.getState().rooms
      const status = connectionStore.getState().status

      if (status !== 'online') {
        console.error('[FLUUX_DEBUG] Not connected. Please connect first.')
        return
      }

      const startDate = new Date()
      startDate.setDate(startDate.getDate() - daysBack)
      const startISO = startDate.toISOString()

      let processed = 0
      let skipped = 0

      for (const [roomJid, room] of rooms) {
        if (!room.joined) {
          console.log(`[FLUUX_DEBUG] Skipping ${roomJid} (not joined)`)
          skipped++
          continue
        }
        if (!room.supportsMAM) {
          console.log(`[FLUUX_DEBUG] Skipping ${roomJid} (no MAM support)`)
          skipped++
          continue
        }
        if (room.isQuickChat) {
          console.log(`[FLUUX_DEBUG] Skipping ${roomJid} (Quick Chat)`)
          skipped++
          continue
        }

        console.log(`[FLUUX_DEBUG] Catching up ${roomJid} from ${startISO}...`)
        try {
          await client.chat.queryRoomMAM({
            roomJid,
            start: startISO,
            max: 500, // Reasonable limit per room
          })
          processed++
          console.log(`[FLUUX_DEBUG] ✓ ${roomJid} done`)
        } catch (err) {
          console.error(`[FLUUX_DEBUG] ✗ ${roomJid} failed:`, err)
        }
      }

      console.log(`[FLUUX_DEBUG] Catchup complete: ${processed} rooms processed, ${skipped} skipped`)
    },

    /**
     * Get the XMPPClient instance for advanced debugging.
     */
    getClient: () => client,

    /**
     * Get current room store state.
     */
    getRooms: () => roomStore.getState().rooms,
  }
}

/**
 * Set up debug utilities on window.__FLUUX_DEBUG__.
 * Call this once when the client is initialized.
 *
 * @param client - The XMPPClient instance
 * @returns Cleanup function to remove the utilities
 */
export function setupDebugUtils(client: XMPPClient): () => void {
  const debugUtils = createDebugUtils(client)

  window.__FLUUX_DEBUG__ = debugUtils

  console.log('[FLUUX] Debug utilities available at window.__FLUUX_DEBUG__')
  console.log('[FLUUX] - catchupAllRooms(days=7): Fetch last N days of messages for all joined rooms')
  console.log('[FLUUX] - getClient(): Get XMPPClient instance')
  console.log('[FLUUX] - getRooms(): Get room store state')

  return () => {
    delete window.__FLUUX_DEBUG__
  }
}
