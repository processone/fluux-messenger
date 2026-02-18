/**
 * XState presence state machine.
 *
 * Manages user presence state with explicit, auditable state transitions.
 * Replaces the error-prone boolean flags (isAutoAway, savedPresenceShow, etc.)
 * with a proper state machine that makes impossible states unrepresentable.
 *
 * ## State Diagram
 *
 * ```
 * ┌─────────────┐
 * │ disconnected│◄──────────────────────────────────────┐
 * └──────┬──────┘                                       │
 *        │ CONNECT                                      │ DISCONNECT
 *        ▼                                              │
 * ┌──────────────────────────────────────────────────────┴──────┐
 * │                        connected                            │
 * │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
 * │  │  userOnline │◄──►│   userAway  │◄──►│   userDnd   │     │
 * │  └──────┬──────┘    └─────────────┘    └─────────────┘     │
 * │         │                                    ▲              │
 * │         │ IDLE_DETECTED                      │              │
 * │         ▼                                    │              │
 * │  ┌─────────────┐    SLEEP_DETECTED    ┌─────┴───────┐      │
 * │  │  autoAway   │────────────────────►│   autoXa    │      │
 * │  └──────┬──────┘                      └──────┬──────┘      │
 * │         │                                    │              │
 * │         └───────────ACTIVITY_DETECTED────────┘              │
 * │                    (restores to saved)                      │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Key Invariants
 *
 * 1. Auto-away states (autoAway, autoXa) always have preAutoAwayState set
 * 2. User states (userOnline, userAway, userDnd) never have preAutoAwayState set
 * 3. Transitions from auto states always restore preAutoAwayState
 * 4. DND is never auto-triggered (user must explicitly set)
 * 5. lastUserPreference tracks user's explicit preference and is restored on CONNECT
 *
 * @module Core/PresenceMachine
 */
import { setup, assign, type ActorRefFrom } from 'xstate'
import type { PresenceStatus, PresenceShow } from './types'

/**
 * User's explicit presence preference.
 * Unlike PresenceStatus, this excludes 'offline' since that's connection-level.
 */
export type UserPresenceShow = 'online' | 'away' | 'dnd'

/**
 * Saved state for auto-away restoration.
 * More precise than UserPresenceShow - DND is never saved since it blocks auto-away.
 */
export type AutoAwaySavedState = 'online' | 'away'

/**
 * Configuration for auto-away behavior.
 * These settings control when the SDK considers the user idle.
 */
export interface AutoAwayConfig {
  /** Whether auto-away is enabled. Default: true */
  enabled: boolean
  /** Time in milliseconds before user is considered idle. Default: 300000 (5 minutes) */
  idleThresholdMs: number
  /** How often to check idle status in milliseconds. Default: 30000 (30 seconds) */
  checkIntervalMs: number
}

/**
 * Default auto-away configuration.
 */
export const DEFAULT_AUTO_AWAY_CONFIG: AutoAwayConfig = {
  enabled: true,
  idleThresholdMs: 5 * 60 * 1000,    // 5 minutes
  checkIntervalMs: 30 * 1000,         // 30 seconds
}

/**
 * Events that can be sent to the presence machine.
 */
export type PresenceEvent =
  | { type: 'CONNECT' }
  | { type: 'DISCONNECT' }
  | { type: 'SET_PRESENCE'; show: UserPresenceShow; status?: string }
  | { type: 'IDLE_DETECTED'; since: Date }
  | { type: 'ACTIVITY_DETECTED' }
  | { type: 'SLEEP_DETECTED' }
  | { type: 'WAKE_DETECTED' }
  | { type: 'SET_AUTO_AWAY_CONFIG'; config: Partial<AutoAwayConfig> }

/**
 * Context (extended state) for the presence machine.
 */
export interface PresenceContext {
  /** Current status message being broadcast */
  statusMessage: string | null
  /** User's presence state before entering auto-away (for restoration).
   *  Only 'online' or 'away' - never 'dnd' since DND blocks auto-away. */
  preAutoAwayState: AutoAwaySavedState | null
  /** User's status message before entering auto-away (for restoration) */
  preAutoAwayStatusMessage: string | null
  /** When user became idle (for XEP-0319 Last User Interaction) */
  idleSince: Date | null
  /** User's last explicit presence preference (preserved across disconnects).
   *  This is updated whenever the user explicitly sets their presence via SET_PRESENCE.
   *  On reconnect, the machine restores to this preference instead of always going to online. */
  lastUserPreference: UserPresenceShow
  /** Auto-away configuration. Can be updated at runtime via SET_AUTO_AWAY_CONFIG. */
  autoAwayConfig: AutoAwayConfig
}

/**
 * The possible state values of the presence machine.
 * Using discriminated union for type-safe state checks.
 */
export type PresenceStateValue =
  | 'disconnected'
  | { connected: 'userOnline' }
  | { connected: 'userAway' }
  | { connected: 'userDnd' }
  | { connected: 'autoAway' }
  | { connected: 'autoXa' }

/**
 * Create the presence state machine definition.
 *
 * The machine manages user presence state with explicit, auditable transitions.
 * It doesn't send presence stanzas directly - instead, components that use
 * the machine should react to state changes and send presence via XMPPClient.
 */
export const presenceMachine = setup({
  types: {
    context: {} as PresenceContext,
    events: {} as PresenceEvent,
  },
  actions: {
    // Clear pre-auto-away state (when user explicitly sets presence)
    clearPreAutoAwayState: assign({
      preAutoAwayState: null,
      preAutoAwayStatusMessage: null,
      idleSince: null,
    }),

    // Save current state before entering auto-away
    saveStateForAutoAway: assign(({ context, event }) => {
      // Determine current user state based on context
      // This action is only called from userOnline state
      return {
        preAutoAwayState: 'online' as AutoAwaySavedState,
        preAutoAwayStatusMessage: context.statusMessage,
        idleSince: event.type === 'IDLE_DETECTED' ? event.since : null,
      }
    }),

    // Save current away state before entering auto-xa (from sleep)
    saveAwayStateForAutoXa: assign(({ context, event }) => {
      // Coming from userAway, save 'away' as the state to restore
      return {
        preAutoAwayState: 'away' as AutoAwaySavedState,
        preAutoAwayStatusMessage: context.statusMessage,
        idleSince: event.type === 'SLEEP_DETECTED' ? new Date() : context.idleSince,
      }
    }),

    // Set status message and update user preference
    setStatusMessage: assign(({ event }) => {
      if (event.type === 'SET_PRESENCE') {
        return {
          statusMessage: event.status ?? null,
          lastUserPreference: event.show,
        }
      }
      return {}
    }),

    // Restore pre-auto-away state after auto-away ends
    restorePreAutoAwayState: assign(({ context }) => ({
      statusMessage: context.preAutoAwayStatusMessage,
      preAutoAwayState: null,
      preAutoAwayStatusMessage: null,
      idleSince: null,
    })),

    // Clear session-specific state on disconnect.
    // NOTE: We preserve lastUserPreference so user's explicit preference is restored on reconnect.
    // We also preserve preAutoAwayState/preAutoAwayStatusMessage for the case where auto-away was active
    // at disconnect time. However, note that preAutoAwayState will be cleared when entering a user
    // state on reconnect, so it's mainly useful if the machine was persisted and restored.
    clearOnDisconnect: assign({
      statusMessage: null,
      // preAutoAwayState: preserved (cleared by user state entry actions)
      // preAutoAwayStatusMessage: preserved (cleared by user state entry actions)
      // lastUserPreference: preserved (restored on CONNECT)
      idleSince: null,
    }),

    // Update auto-away configuration
    updateAutoAwayConfig: assign(({ context, event }) => {
      if (event.type !== 'SET_AUTO_AWAY_CONFIG') return {}
      return {
        autoAwayConfig: {
          ...context.autoAwayConfig,
          ...event.config,
        },
      }
    }),
  },
  guards: {
    // Guard to check if we have a pre-auto-away state to restore
    hasPreAutoAwayState: ({ context }) => context.preAutoAwayState !== null,

    // Guard to check if transitioning to DND (DND blocks auto-away)
    isNotDnd: ({ event }) => {
      if (event.type === 'SET_PRESENCE') {
        return event.show !== 'dnd'
      }
      return true
    },

    // Guards for CONNECT transition to restore user's last preference
    lastPreferenceIsAway: ({ context }) => context.lastUserPreference === 'away',
    lastPreferenceIsDnd: ({ context }) => context.lastUserPreference === 'dnd',
  },
}).createMachine({
  id: 'presence',
  context: {
    statusMessage: null,
    preAutoAwayState: null,
    preAutoAwayStatusMessage: null,
    idleSince: null,
    lastUserPreference: 'online',
    autoAwayConfig: DEFAULT_AUTO_AWAY_CONFIG,
  },
  initial: 'disconnected',
  // Global event handlers - can be received in any state
  on: {
    SET_AUTO_AWAY_CONFIG: {
      actions: 'updateAutoAwayConfig',
    },
  },
  states: {
    disconnected: {
      on: {
        // CONNECT restores user's last explicit preference instead of always going to online.
        // This preserves user intent across disconnects (e.g., user set DND, network drops,
        // network reconnects → user should still be in DND).
        CONNECT: [
          {
            guard: 'lastPreferenceIsDnd',
            target: 'connected.userDnd',
          },
          {
            guard: 'lastPreferenceIsAway',
            target: 'connected.userAway',
          },
          {
            // Default: online (most common case)
            target: 'connected.userOnline',
          },
        ],
      },
    },
    connected: {
      initial: 'userOnline',
      on: {
        DISCONNECT: {
          target: 'disconnected',
          actions: 'clearOnDisconnect',
        },
      },
      states: {
        /**
         * User is explicitly online (default connected state).
         * Can transition to:
         * - userAway/userDnd via SET_PRESENCE
         * - autoAway via IDLE_DETECTED
         */
        userOnline: {
          entry: 'clearPreAutoAwayState',
          on: {
            SET_PRESENCE: [
              {
                // Allow updating status message while staying online
                guard: ({ event }) => event.show === 'online',
                actions: 'setStatusMessage',
              },
              {
                guard: ({ event }) => event.show === 'away',
                target: 'userAway',
                actions: 'setStatusMessage',
              },
              {
                guard: ({ event }) => event.show === 'dnd',
                target: 'userDnd',
                actions: 'setStatusMessage',
              },
            ],
            IDLE_DETECTED: {
              target: 'autoAway',
              actions: 'saveStateForAutoAway',
            },
            SLEEP_DETECTED: {
              target: 'autoXa',
              actions: assign(({ context }) => ({
                preAutoAwayState: 'online' as AutoAwaySavedState,
                preAutoAwayStatusMessage: context.statusMessage,
                idleSince: new Date(),
              })),
            },
          },
        },

        /**
         * User is explicitly away.
         * Can transition to:
         * - userOnline/userDnd via SET_PRESENCE
         * - autoXa via SLEEP_DETECTED (saves 'away' as restore target)
         */
        userAway: {
          entry: 'clearPreAutoAwayState',
          on: {
            SET_PRESENCE: [
              {
                guard: ({ event }) => event.show === 'online',
                target: 'userOnline',
                actions: 'setStatusMessage',
              },
              {
                guard: ({ event }) => event.show === 'dnd',
                target: 'userDnd',
                actions: 'setStatusMessage',
              },
              {
                // Allow updating status message while staying away
                guard: ({ event }) => event.show === 'away',
                actions: 'setStatusMessage',
              },
            ],
            SLEEP_DETECTED: {
              target: 'autoXa',
              actions: 'saveAwayStateForAutoXa',
            },
            // IDLE_DETECTED is ignored in userAway (already away)
          },
        },

        /**
         * User is explicitly in DND mode.
         * DND is never auto-triggered and blocks all auto-transitions.
         * Can only leave via explicit SET_PRESENCE.
         */
        userDnd: {
          entry: 'clearPreAutoAwayState',
          on: {
            SET_PRESENCE: [
              {
                guard: ({ event }) => event.show === 'online',
                target: 'userOnline',
                actions: 'setStatusMessage',
              },
              {
                guard: ({ event }) => event.show === 'away',
                target: 'userAway',
                actions: 'setStatusMessage',
              },
              {
                // Allow updating status message while staying in DND
                guard: ({ event }) => event.show === 'dnd',
                actions: 'setStatusMessage',
              },
            ],
            // DND blocks IDLE_DETECTED and SLEEP_DETECTED
          },
        },

        /**
         * System automatically set user to away due to idle.
         * preAutoAwayState contains the user's previous state (always 'online').
         * Can transition to:
         * - userOnline (or preAutoAwayState) via ACTIVITY_DETECTED
         * - autoXa via SLEEP_DETECTED
         * - userDnd via SET_PRESENCE (DND always takes precedence)
         */
        autoAway: {
          on: {
            ACTIVITY_DETECTED: {
              target: 'userOnline',
              actions: 'restorePreAutoAwayState',
            },
            WAKE_DETECTED: {
              target: 'userOnline',
              actions: 'restorePreAutoAwayState',
            },
            SLEEP_DETECTED: {
              target: 'autoXa',
              // Keep existing preAutoAwayState (the state before auto-away)
            },
            SET_PRESENCE: [
              {
                // DND always takes precedence, even from auto-away
                guard: ({ event }) => event.show === 'dnd',
                target: 'userDnd',
                actions: ['setStatusMessage', 'clearPreAutoAwayState'],
              },
              {
                // User explicitly sets online - clear auto-away
                guard: ({ event }) => event.show === 'online',
                target: 'userOnline',
                actions: 'setStatusMessage',
              },
              {
                // User explicitly sets away - convert to manual away
                guard: ({ event }) => event.show === 'away',
                target: 'userAway',
                actions: 'setStatusMessage',
              },
            ],
          },
        },

        /**
         * System automatically set user to extended away (xa) due to sleep.
         * preAutoAwayState contains the user's previous state ('online' or 'away').
         * Can transition to:
         * - userOnline/userAway (based on preAutoAwayState) via WAKE_DETECTED
         * - userDnd via SET_PRESENCE (DND always takes precedence)
         */
        autoXa: {
          on: {
            ACTIVITY_DETECTED: [
              {
                guard: ({ context }) => context.preAutoAwayState === 'away',
                target: 'userAway',
                actions: 'restorePreAutoAwayState',
              },
              {
                // Default: restore to online
                target: 'userOnline',
                actions: 'restorePreAutoAwayState',
              },
            ],
            WAKE_DETECTED: [
              {
                guard: ({ context }) => context.preAutoAwayState === 'away',
                target: 'userAway',
                actions: 'restorePreAutoAwayState',
              },
              {
                // Default: restore to online
                target: 'userOnline',
                actions: 'restorePreAutoAwayState',
              },
            ],
            SET_PRESENCE: [
              {
                guard: ({ event }) => event.show === 'dnd',
                target: 'userDnd',
                actions: ['setStatusMessage', 'clearPreAutoAwayState'],
              },
              {
                guard: ({ event }) => event.show === 'online',
                target: 'userOnline',
                actions: 'setStatusMessage',
              },
              {
                guard: ({ event }) => event.show === 'away',
                target: 'userAway',
                actions: 'setStatusMessage',
              },
            ],
          },
        },
      },
    },
  },
})

/**
 * Type for a running presence machine actor.
 */
export type PresenceActor = ActorRefFrom<typeof presenceMachine>

/**
 * Helper to get the current presence show value to send to the server.
 * Maps machine state to XMPP show element value.
 *
 * @param stateValue - Current state value from the machine
 * @returns The XMPP show value (undefined means 'online')
 */
export function getPresenceShowFromState(stateValue: PresenceStateValue): PresenceShow | undefined {
  if (stateValue === 'disconnected') return undefined

  const connectedState = stateValue.connected
  switch (connectedState) {
    case 'userOnline':
      return undefined // No <show> element = available/online
    case 'userAway':
      return 'away'
    case 'userDnd':
      return 'dnd'
    case 'autoAway':
      return 'away'
    case 'autoXa':
      return 'xa'
  }
}

/**
 * Helper to get the PresenceStatus (UI-level) from machine state.
 *
 * @param stateValue - Current state value from the machine
 * @returns The UI-level presence status
 */
export function getPresenceStatusFromState(stateValue: PresenceStateValue): PresenceStatus {
  if (stateValue === 'disconnected') return 'offline'

  const connectedState = stateValue.connected
  switch (connectedState) {
    case 'userOnline':
      return 'online'
    case 'userAway':
    case 'autoAway':
    case 'autoXa':
      return 'away'
    case 'userDnd':
      return 'dnd'
  }
}

/**
 * Helper to check if currently in an auto-away state.
 *
 * @param stateValue - Current state value from the machine
 * @returns True if in autoAway or autoXa state
 */
export function isAutoAwayState(stateValue: PresenceStateValue): boolean {
  if (stateValue === 'disconnected') return false
  const connectedState = stateValue.connected
  return connectedState === 'autoAway' || connectedState === 'autoXa'
}

/**
 * Helper to get the connected child state name, or null if disconnected.
 *
 * @param stateValue - Current state value from the machine
 * @returns The connected state name or null
 */
export function getConnectedStateName(stateValue: PresenceStateValue): string | null {
  if (stateValue === 'disconnected') return null
  return stateValue.connected
}
