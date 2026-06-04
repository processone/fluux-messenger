import { useRoomStore } from '@fluux/sdk/react'
import { roomSelectors } from '@fluux/sdk'
import { whisperTargetPresent, type WhisperTarget } from '@/components/conversation'

/**
 * Whether a whisper counterpart is still present in `roomJid`.
 *
 * Narrow by design (XEP-0045 §7.5): subscribes to a single derived boolean, so
 * the consumer re-renders only when this counterpart's presence flips — not on
 * every occupant/message/typing change in the room. Returns `false` (no work)
 * when not in whisper mode (`target` is null/undefined). Occupant-id aware via
 * {@link whisperTargetPresent}, with a nick fallback.
 */
export function useWhisperCounterpartPresent(
  roomJid: string,
  target: WhisperTarget | null | undefined,
): boolean {
  return useRoomStore((s) => {
    if (!target) return false
    const occupants = roomSelectors.runtimeOccupantsFor(roomJid)(s)
    return whisperTargetPresent(target, occupants)
  })
}
