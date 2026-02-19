/**
 * XState connection state machine.
 *
 * Manages XMPP connection lifecycle with explicit, auditable state transitions.
 * Replaces the error-prone boolean flags (isReconnecting, hasEverConnected,
 * isManualDisconnect, disconnectReason) with a proper state machine that makes
 * impossible states unrepresentable.
 *
 * ## State Diagram
 *
 * ```
 * ┌──────┐
 * │ idle │◄──────────────────────────────────────────────────┐
 * └──┬───┘                                                   │
 *    │ CONNECT                                          CONNECT (reset)
 *    ▼                                                       │
 * ┌────────────┐  CONNECTION_ERROR  ┌────────────────────────┴──────┐
 * │ connecting  │──────────────────►│           terminal             │
 * └──────┬─────┘                    │  ┌──────────────────┐         │
 *        │                          │  │  initialFailure  │         │
 *        │ CONNECTION_SUCCESS       │  ├──────────────────┤         │
 *        ▼                          │  │    conflict      │         │
 * ┌──────────────────────────┐      │  ├──────────────────┤         │
 * │        connected          │─────►│  │   authFailed     │         │
 * │ ┌─────────┐ ┌──────────┐│CONFLICT│  └──────────────────┘         │
 * │ │ healthy │ │verifying ││AUTH_ERR│                               │
 * │ └────┬────┘ └────┬─────┘│      │                                │
 * │      │           │       │      └───────────────────────────────┘
 * │  SOCKET_DIED  VERIFY_FAILED
 * │  WAKE(long)      │
 * └──────┬───────────┘
 *        ▼
 * ┌──────────────────────────┐
 * │        reconnecting       │
 * │ ┌──────────┐ ┌──────────┐ │
 * │ │ waiting   │ │attempting│ │
 * │ └──────────┘ └──────────┘ │
 * └──────┬─────────────────────┘
 *        │ DISCONNECT / CANCEL_RECONNECT
 *        ▼
 * ┌──────────────┐
 * │ disconnected  │──── CONNECT ────► idle
 * └──────────────┘
 * ```
 *
 * ## Key Invariants
 *
 * 1. Reconnection only happens from `connected` or `reconnecting` states
 * 2. Terminal states block all auto-recovery — only user-initiated CONNECT escapes
 * 3. `connecting` state only transitions to `connected` or `terminal.initialFailure`
 * 4. Exponential backoff context is always consistent with the current state
 * 5. CONFLICT and AUTH_ERROR are terminal from any connected/reconnecting state
 * 6. Reconnect retries are unbounded for non-fatal errors, but delay growth is capped
 *    (`nextRetryDelayMs` stops increasing after `MAX_RECONNECT_DELAY`)
 *
 * @module Core/ConnectionMachine
 */
import { setup, assign, type ActorRefFrom } from 'xstate'
import type { ConnectionStatus } from './types'

// ============================================================================
// Constants
// ============================================================================

/** Initial delay before first reconnect attempt (ms) */
export const INITIAL_RECONNECT_DELAY = 1000

/** Maximum delay between reconnect attempts (ms) */
export const MAX_RECONNECT_DELAY = 120_000

/** Multiplier for exponential backoff */
export const RECONNECT_MULTIPLIER = 2

/** Maximum reconnect attempt value used to cap backoff growth (retries continue). */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10

/** Stream Management session timeout — server-side, typically 10 minutes (ms) */
export const SM_SESSION_TIMEOUT_MS = 10 * 60 * 1000

// ============================================================================
// Types
// ============================================================================

/**
 * Events that can be sent to the connection machine.
 */
export type ConnectionMachineEvent =
  | { type: 'CONNECT' }
  | { type: 'DISCONNECT' }
  | { type: 'CONNECTION_SUCCESS' }
  | { type: 'CONNECTION_ERROR'; error: string }
  | { type: 'SOCKET_DIED' }
  | { type: 'WAKE'; sleepDurationMs?: number }
  | { type: 'VISIBLE' }
  | { type: 'VERIFY_SUCCESS' }
  | { type: 'VERIFY_FAILED' }
  | { type: 'CONFLICT' }
  | { type: 'AUTH_ERROR' }
  | { type: 'CANCEL_RECONNECT' }
  | { type: 'TRIGGER_RECONNECT' }

/**
 * Context (extended state) for the connection machine.
 */
export interface ConnectionMachineContext {
  /** Current reconnect attempt number (1-based during reconnection, 0 when not reconnecting) */
  reconnectAttempt: number
  /** Maximum reconnect attempt value used for backoff growth saturation */
  maxReconnectAttempts: number
  /** Delay before next reconnect attempt (ms), computed via exponential backoff */
  nextRetryDelayMs: number
  /** Absolute timestamp (ms since epoch) when the next reconnect attempt fires, null when not waiting */
  reconnectTargetTime: number | null
  /** Last error message, null when no error */
  lastError: string | null
}

/**
 * The possible state values of the connection machine.
 * Using discriminated union for type-safe state checks.
 */
export type ConnectionStateValue =
  | 'idle'
  | 'connecting'
  | { connected: 'healthy' }
  | { connected: 'verifying' }
  | { reconnecting: 'waiting' }
  | { reconnecting: 'attempting' }
  | { terminal: 'conflict' }
  | { terminal: 'authFailed' }
  | { terminal: 'maxRetries' }
  | { terminal: 'initialFailure' }
  | 'disconnected'

// ============================================================================
// Helpers (pure functions)
// ============================================================================

/**
 * Compute exponential backoff delay for a given attempt number.
 *
 * @param attempt - 1-based attempt number
 * @returns Delay in milliseconds, capped at MAX_RECONNECT_DELAY
 */
function computeBackoffDelay(attempt: number): number {
  return Math.min(
    INITIAL_RECONNECT_DELAY * Math.pow(RECONNECT_MULTIPLIER, attempt - 1),
    MAX_RECONNECT_DELAY
  )
}

// ============================================================================
// Machine Definition
// ============================================================================

/**
 * Create the connection state machine definition.
 *
 * The machine manages connection lifecycle with explicit, auditable transitions.
 * It doesn't perform I/O directly — instead, the Connection module subscribes
 * to state changes and performs side effects (XMPP operations, timer management).
 */
export const connectionMachine = setup({
  types: {
    context: {} as ConnectionMachineContext,
    events: {} as ConnectionMachineEvent,
  },
  actions: {
    // Reset all reconnection-related context to defaults
    resetReconnectState: assign({
      reconnectAttempt: 0,
      nextRetryDelayMs: 0,
      reconnectTargetTime: null,
      lastError: null,
    }),

    // Increment attempt counter and compute next backoff delay.
    // Attempt value saturates at maxReconnectAttempts so the UI attempt label
    // and delay remain stable after hitting the backoff ceiling.
    // Sets reconnectTargetTime as an absolute timestamp for UI countdown.
    incrementAttempt: assign(({ context }) => {
      const attempt = Math.min(context.reconnectAttempt + 1, context.maxReconnectAttempts)
      const delay = computeBackoffDelay(attempt)
      return {
        reconnectAttempt: attempt,
        nextRetryDelayMs: delay,
        reconnectTargetTime: Date.now() + delay,
      }
    }),

    // Store error message from event
    setError: assign(({ event }) => {
      if (event.type === 'CONNECTION_ERROR') {
        return { lastError: event.error }
      }
      return {}
    }),

    // Set a static error message (for terminal states)
    setConflictError: assign({
      lastError: 'Session replaced by another client',
    }),

    setAuthError: assign({
      lastError: 'Authentication failed',
    }),

    // Clear target time (entering attempting state)
    clearTargetTime: assign({
      reconnectTargetTime: null,
    }),

    // Clear error
    clearError: assign({
      lastError: null,
    }),
  },
  guards: {
    // Did the sleep duration exceed SM session timeout?
    sleepExceedsSMTimeout: ({ event }) => {
      if (event.type === 'WAKE') {
        return (event.sleepDurationMs ?? 0) > SM_SESSION_TIMEOUT_MS
      }
      return false
    },
  },
  delays: {
    reconnectDelay: ({ context }) => context.nextRetryDelayMs,
  },
}).createMachine({
  id: 'connection',
  context: {
    reconnectAttempt: 0,
    maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
    nextRetryDelayMs: 0,
    reconnectTargetTime: null,
    lastError: null,
  },
  initial: 'idle',
  states: {
    /**
     * Fresh client — no connection has been attempted.
     * Entry point for the machine and reset target after terminal states.
     */
    idle: {
      on: {
        CONNECT: {
          target: 'connecting',
          actions: 'clearError',
        },
      },
    },

    /**
     * Initial connection attempt in progress.
     * Only transitions to connected.healthy on success or terminal.initialFailure on error.
     * This state does NOT auto-retry — if the first connection fails, the user sees the error.
     */
    connecting: {
      on: {
        CONNECTION_SUCCESS: {
          target: 'connected',
          actions: 'resetReconnectState',
        },
        CONNECTION_ERROR: {
          target: 'terminal.initialFailure',
          actions: 'setError',
        },
        // User can disconnect during initial connection
        DISCONNECT: {
          target: 'disconnected',
          actions: 'resetReconnectState',
        },
      },
    },

    /**
     * Successfully connected to the XMPP server.
     */
    connected: {
      initial: 'healthy',
      on: {
        // These can happen from any connected substate
        DISCONNECT: {
          target: 'disconnected',
          actions: 'resetReconnectState',
        },
        CONFLICT: {
          target: 'terminal.conflict',
          actions: 'setConflictError',
        },
        AUTH_ERROR: {
          target: 'terminal.authFailed',
          actions: 'setAuthError',
        },
      },
      states: {
        /**
         * Normal connected operation.
         * Can transition to verifying (wake check) or reconnecting (socket death).
         */
        healthy: {
          on: {
            SOCKET_DIED: {
              target: '#connection.reconnecting',
              actions: 'incrementAttempt',
            },
            WAKE: [
              {
                // Long sleep exceeds SM timeout — skip verification, reconnect immediately
                guard: 'sleepExceedsSMTimeout',
                target: '#connection.reconnecting',
                actions: 'incrementAttempt',
              },
              {
                // Short sleep — verify connection health first
                target: 'verifying',
              },
            ],
          },
        },

        /**
         * Checking connection health after wake from sleep.
         * The Connection module sends a ping/SM ack and reports the result.
         */
        verifying: {
          on: {
            VERIFY_SUCCESS: {
              target: 'healthy',
            },
            VERIFY_FAILED: {
              target: '#connection.reconnecting',
              actions: 'incrementAttempt',
            },
            // Socket can die while we're verifying
            SOCKET_DIED: {
              target: '#connection.reconnecting',
              actions: 'incrementAttempt',
            },
          },
        },
      },
    },

    /**
     * Lost connection, attempting to recover with exponential backoff.
     */
    reconnecting: {
      initial: 'waiting',
      on: {
        // These can happen from any reconnecting substate
        DISCONNECT: {
          target: 'disconnected',
          actions: 'resetReconnectState',
        },
        CANCEL_RECONNECT: {
          target: 'disconnected',
          actions: 'resetReconnectState',
        },
        CONFLICT: {
          target: 'terminal.conflict',
          actions: ['resetReconnectState', 'setConflictError'],
        },
        AUTH_ERROR: {
          target: 'terminal.authFailed',
          actions: ['resetReconnectState', 'setAuthError'],
        },
      },
      states: {
        /**
         * Waiting for backoff timer to expire before next attempt.
         * The UI reads reconnectTargetTime from context to display a local countdown.
         * Timer expiry or user trigger starts attempt.
         */
        waiting: {
          after: {
            reconnectDelay: {
              target: 'attempting',
              actions: 'clearTargetTime',
            },
          },
          on: {
            TRIGGER_RECONNECT: {
              target: 'attempting',
              actions: 'clearTargetTime',
            },
            // Wake or visibility while waiting — skip to immediate attempt
            WAKE: {
              target: 'attempting',
              actions: 'clearTargetTime',
            },
            VISIBLE: {
              target: 'attempting',
              actions: 'clearTargetTime',
            },
          },
        },

        /**
         * Actively attempting to reconnect.
         * The Connection module performs the actual XMPP reconnection.
         */
        attempting: {
          on: {
            CONNECTION_SUCCESS: {
              target: '#connection.connected',
              actions: 'resetReconnectState',
            },
            CONNECTION_ERROR: {
              target: 'waiting',
              actions: ['setError', 'incrementAttempt'],
            },
            // Socket can die during reconnect attempt (e.g., proxy failure)
            SOCKET_DIED: {
              target: 'waiting',
              actions: 'incrementAttempt',
            },
          },
        },
      },
    },

    /**
     * Unrecoverable failure — no auto-recovery possible.
     * User must send CONNECT to try again (transitions back to idle).
     */
    terminal: {
      initial: 'initialFailure',
      on: {
        CONNECT: {
          target: 'idle',
          actions: 'resetReconnectState',
        },
      },
      states: {
        /** Resource conflict — another client connected with same resource */
        conflict: {},
        /** Authentication failed — wrong password or account issue */
        authFailed: {},
        /** Exhausted all reconnect attempts */
        maxRetries: {},
        /** Initial connection never succeeded (first attempt failed) */
        initialFailure: {},
      },
    },

    /**
     * User manually disconnected (clean shutdown).
     * Can reconnect via CONNECT.
     */
    disconnected: {
      entry: 'resetReconnectState',
      on: {
        CONNECT: {
          target: 'connecting',
          actions: 'clearError',
        },
      },
    },
  },
})

// ============================================================================
// Actor Type
// ============================================================================

/**
 * Type for a running connection machine actor.
 */
export type ConnectionActor = ActorRefFrom<typeof connectionMachine>

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map machine state to the existing ConnectionStatus type for the store.
 *
 * This mapping preserves backward compatibility with all UI components and hooks
 * that depend on the ConnectionStatus string union.
 *
 * @param stateValue - Current state value from the machine
 * @returns The ConnectionStatus for the store
 */
export function getConnectionStatusFromState(stateValue: ConnectionStateValue): ConnectionStatus {
  if (typeof stateValue === 'string') {
    switch (stateValue) {
      case 'idle':
        return 'disconnected'
      case 'connecting':
        return 'connecting'
      case 'disconnected':
        return 'disconnected'
    }
  }

  if ('connected' in stateValue) {
    switch (stateValue.connected) {
      case 'healthy':
        return 'online'
      case 'verifying':
        return 'verifying'
    }
  }

  if ('reconnecting' in stateValue) {
    switch (stateValue.reconnecting) {
      case 'waiting':
        return 'reconnecting'
      case 'attempting':
        return 'connecting'
    }
  }

  if ('terminal' in stateValue) {
    return 'error'
  }

  // Exhaustive — should never reach here
  return 'disconnected'
}

/**
 * Check if the machine is in a terminal (unrecoverable) state.
 *
 * @param stateValue - Current state value from the machine
 * @returns True if in any terminal substate
 */
export function isTerminalState(stateValue: ConnectionStateValue): boolean {
  return typeof stateValue === 'object' && 'terminal' in stateValue
}

/**
 * Extract reconnection info from machine context for UI display.
 *
 * @param context - Current machine context
 * @returns Reconnect attempt number and target time for countdown
 */
export function getReconnectInfoFromContext(context: ConnectionMachineContext): {
  attempt: number
  reconnectTargetTime: number | null
} {
  return {
    attempt: context.reconnectAttempt,
    reconnectTargetTime: context.reconnectTargetTime,
  }
}
