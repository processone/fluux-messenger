/**
 * useSystemState hook - Clean API for platform-to-SDK signaling.
 *
 * This hook provides a simplified interface for apps to signal system state
 * changes (idle, active, sleep, wake) to the SDK. The SDK then decides what
 * to do based on its internal state and configuration.
 *
 * ## Design Philosophy
 *
 * The app signals *what happened*, the SDK decides *what to do about it*.
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                        App (Platform Layer)                      │
 * │  - Platform detection (wake, idle, visibility, Tauri events)    │
 * │  - Signals: notifyIdle(), notifyActive(), notifyWake(), etc.    │
 * ├─────────────────────────────────────────────────────────────────┤
 * │                              ↓ Signals ↓                         │
 * ├─────────────────────────────────────────────────────────────────┤
 * │                        SDK (Protocol Layer)                      │
 * │  - Presence state machine handles transitions                    │
 * │  - Connection verification on wake                               │
 * │  - Auto-away logic based on configuration                        │
 * └─────────────────────────────────────────────────────────────────┘
 * ```
 *
 * @module Hooks/useSystemState
 * @category Hooks
 */
import { useCallback, useMemo } from 'react'
import { usePresenceContext } from '../provider/PresenceContext'
import type { AutoAwayConfig } from '../core/presenceMachine'

/**
 * System state that the app can signal to the SDK.
 */
export type SystemState = 'idle' | 'active' | 'asleep' | 'awake' | 'visible' | 'hidden'

/**
 * Return type for the useSystemState hook.
 */
export interface UseSystemStateReturn {
  /**
   * Signal a system state change to the SDK.
   *
   * The SDK will:
   * - 'idle': Transition to auto-away if enabled and threshold met
   * - 'active': Restore from auto-away if currently in that state
   * - 'asleep': Transition to extended away (xa)
   * - 'awake': Verify connection, restore from auto-away
   * - 'visible': Check if user is active, restore if so
   * - 'hidden': Currently no action (could adjust keepalive in future)
   *
   * @param state - The system state to signal
   * @param idleSince - For 'idle' state, when the user became idle
   */
  notifySystemState: (state: SystemState, idleSince?: Date) => void

  /**
   * Convenience method: notify user is idle.
   * @param since - When the user became idle
   */
  notifyIdle: (since: Date) => void

  /**
   * Convenience method: notify user activity detected.
   */
  notifyActive: () => void

  /**
   * Convenience method: notify system going to sleep.
   */
  notifySleep: () => void

  /**
   * Convenience method: notify system woke from sleep.
   */
  notifyWake: () => void

  /**
   * Update auto-away configuration.
   * @param config - Partial configuration to merge
   */
  setAutoAwayConfig: (config: Partial<AutoAwayConfig>) => void

  /**
   * Current auto-away configuration from presence machine.
   */
  autoAwayConfig: AutoAwayConfig
}

/**
 * Hook for signaling system state changes to the SDK.
 *
 * Provides a clean, high-level API for platform-specific code to communicate
 * system state (idle, wake, sleep, visibility) to the SDK without needing
 * to understand the internal presence state machine.
 *
 * @example Basic usage
 * ```tsx
 * function PlatformIntegration() {
 *   const { notifyIdle, notifyActive, notifyWake, notifySleep } = useSystemState()
 *
 *   useEffect(() => {
 *     // Tauri: listen for system wake
 *     const unlisten = listen('system-did-wake', () => notifyWake())
 *     return () => unlisten.then(fn => fn())
 *   }, [notifyWake])
 *
 *   useEffect(() => {
 *     // Check OS idle time periodically
 *     const interval = setInterval(async () => {
 *       const idleSeconds = await invoke('get_idle_time')
 *       if (idleSeconds > 300) {
 *         notifyIdle(new Date(Date.now() - idleSeconds * 1000))
 *       }
 *     }, 30000)
 *     return () => clearInterval(interval)
 *   }, [notifyIdle])
 * }
 * ```
 *
 * @returns System state signaling methods
 * @category Hooks
 */
export function useSystemState(): UseSystemStateReturn {
  const { presenceActor } = usePresenceContext()

  // Get auto-away config from presence machine context
  const autoAwayConfig = presenceActor.getSnapshot().context.autoAwayConfig

  /**
   * Presence-focused system state notification.
   *
   * This hook handles presence machine transitions only. For connection-level
   * concerns (verification, reconnection), use `client.notifySystemState()`
   * directly — it orchestrates both presence and connection in one call.
   */
  const notifySystemState = useCallback((state: SystemState, idleSince?: Date) => {
    switch (state) {
      case 'idle':
        // Signal idle to presence machine - it will transition to auto-away
        // if enabled and currently in a state that allows it
        if (idleSince) {
          presenceActor.send({ type: 'IDLE_DETECTED', since: idleSince })
        }
        break

      case 'active':
        // Signal activity - presence machine will restore from auto-away if needed
        presenceActor.send({ type: 'ACTIVITY_DETECTED' })
        break

      case 'asleep':
        // System going to sleep - transition to extended away
        presenceActor.send({ type: 'SLEEP_DETECTED' })
        break

      case 'awake':
        // Signal wake to presence machine (restores from auto-away).
        // Connection verification is handled by client.notifySystemState('awake')
        // when called by the app's platform detection hook.
        presenceActor.send({ type: 'WAKE_DETECTED' })
        break

      case 'visible':
      case 'hidden':
        // No presence action — app handles visibility-based activity detection
        // with appropriate time thresholds.
        break
    }
  }, [presenceActor])

  // Convenience methods
  const notifyIdle = useCallback((since: Date) => {
    notifySystemState('idle', since)
  }, [notifySystemState])

  const notifyActive = useCallback(() => {
    notifySystemState('active')
  }, [notifySystemState])

  const notifySleep = useCallback(() => {
    notifySystemState('asleep')
  }, [notifySystemState])

  const notifyWake = useCallback(() => {
    notifySystemState('awake')
  }, [notifySystemState])

  const setAutoAwayConfig = useCallback((config: Partial<AutoAwayConfig>) => {
    presenceActor.send({ type: 'SET_AUTO_AWAY_CONFIG', config })
  }, [presenceActor])

  return useMemo(() => ({
    notifySystemState,
    notifyIdle,
    notifyActive,
    notifySleep,
    notifyWake,
    setAutoAwayConfig,
    autoAwayConfig,
  }), [notifySystemState, notifyIdle, notifyActive, notifySleep, notifyWake, setAutoAwayConfig, autoAwayConfig])
}
