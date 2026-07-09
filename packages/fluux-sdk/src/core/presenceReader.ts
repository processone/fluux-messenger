/**
 * Presence reader — the narrow read surface the domain modules use to consult
 * the presence machine.
 *
 * Presence is machine state, not connection-store state, so it does not belong
 * on the connection store binding. Modules receive a `PresenceReader` through
 * their dependencies instead; the client builds one from the presence machine
 * (see `XMPPClient`), and headless/bot consumers that supply no presence
 * integration get sensible defaults.
 */
import type { PresenceOptions } from './types/client'

/**
 * The presence getters modules actually consume. A read-only projection of the
 * presence machine — deliberately excludes the {@link PresenceOptions} setters,
 * which no module calls (presence transitions go through the machine directly).
 */
export interface PresenceReader {
  getPresenceShow: () => 'online' | 'away' | 'dnd' | 'offline'
  getStatusMessage: () => string | null
  getIsAutoAway: () => boolean
  getPreAutoAwayState: () => 'online' | 'away' | 'dnd' | 'offline' | null
  getPreAutoAwayStatusMessage: () => string | null
}

/**
 * Build a {@link PresenceReader} from optional presence integration getters,
 * filling headless defaults for anything omitted. The defaults mirror a
 * disconnected/never-away client so bots and tests behave predictably without
 * wiring a presence machine.
 */
export function createPresenceReader(options?: PresenceOptions): PresenceReader {
  return {
    getPresenceShow: options?.getPresenceShow ?? (() => 'online'),
    getStatusMessage: options?.getStatusMessage ?? (() => null),
    getIsAutoAway: options?.getIsAutoAway ?? (() => false),
    getPreAutoAwayState: options?.getPreAutoAwayState ?? (() => null),
    getPreAutoAwayStatusMessage: options?.getPreAutoAwayStatusMessage ?? (() => null),
  }
}
