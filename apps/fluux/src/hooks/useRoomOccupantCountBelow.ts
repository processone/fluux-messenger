import { useRoomStore } from '@fluux/sdk/react'
import { roomSelectors } from '@fluux/sdk'

/**
 * Whether `roomJid` currently has fewer than `threshold` occupants.
 *
 * Narrow by design: subscribes to a single derived boolean, so the consumer
 * re-renders only when the room CROSSES the threshold — not on every join/leave.
 * `useRoomOccupantCount` returns the raw size, which changes on every membership
 * event; when a consumer only needs a threshold decision (e.g. "is this room
 * small enough to send typing notifications?"), subscribe to the boolean instead
 * so join/leave churn in a stably-large (or stably-small) room costs no renders.
 *
 * Mirrors {@link useWhisperCounterpartPresent}: derive the boolean inside the
 * store selector so Zustand's Object.is check bails the re-render while it holds.
 */
export function useRoomOccupantCountBelow(roomJid: string, threshold: number): boolean {
  return useRoomStore((s) => roomSelectors.runtimeOccupantCountFor(roomJid)(s) < threshold)
}
