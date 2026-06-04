import { whisperCounterpartPresent } from './messageGrouping'

/**
 * Composer whisper target (XEP-0045 §7.5). Holds the counterpart's nick plus the
 * stable occupant-id (XEP-0421) captured the moment whisper mode is entered.
 * The occupant-id lets presence checks re-bind to the same *person* — surviving
 * nick changes and refusing a nick that a different occupant later recycled —
 * so the typed private text can never be mis-addressed. Absent in rooms without
 * occupant-id support, where checks fall back to the nick.
 */
export interface WhisperTarget {
  nick: string
  occupantId?: string
}

/**
 * Capture a {@link WhisperTarget} for `nick` from the live occupant list,
 * resolving the occupant-id once at entry time. Existing whisper-entry call
 * sites pass only a nick; the occupant-id is filled in here.
 */
export function resolveWhisperTarget(
  nick: string,
  occupants: ReadonlyMap<string, { occupantId?: string }>,
): WhisperTarget {
  return { nick, occupantId: occupants.get(nick)?.occupantId }
}

/**
 * Whether the whisper counterpart is still in the room — occupant-id aware with
 * a nick fallback. Shares {@link whisperCounterpartPresent} so the reply-gate,
 * the composer Send-disable, and the send-time backstop all agree.
 */
export function whisperTargetPresent(
  target: WhisperTarget,
  occupants: ReadonlyMap<string, { occupantId?: string }>,
): boolean {
  return whisperCounterpartPresent(
    { whisperWith: target.nick, whisperWithOccupantId: target.occupantId },
    occupants,
  )
}

/**
 * Outcome of the send-time whisper guard. `empty` is a silent no-op (nothing
 * typed); `counterpart-gone` should surface a toast and preserve the draft.
 */
export type WhisperSendDecision =
  | { ok: true; nick: string; body: string }
  | { ok: false; reason: 'empty' | 'counterpart-gone'; nick: string }

/**
 * Decide whether a whisper may be sent right now. Pure backstop for the RoomView
 * send handler: trims the text, refuses empty input, and — critically — refuses
 * if the captured counterpart is no longer present (left, or the nick is now held
 * by a different occupant-id). Callers should evaluate this against the *live*
 * occupant list so it covers the gap between the counterpart leaving and React
 * re-rendering the disabled Send button.
 */
export function decideWhisperSend(
  target: WhisperTarget,
  rawText: string,
  occupants: ReadonlyMap<string, { occupantId?: string }>,
): WhisperSendDecision {
  const body = rawText.trim()
  if (!body) return { ok: false, reason: 'empty', nick: target.nick }
  if (!whisperTargetPresent(target, occupants)) {
    return { ok: false, reason: 'counterpart-gone', nick: target.nick }
  }
  return { ok: true, nick: target.nick, body }
}
