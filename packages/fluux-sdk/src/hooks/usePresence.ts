/**
 * usePresence hook - Manages user presence via XState machine.
 *
 * This hook provides access to the presence state machine, which replaces
 * the error-prone boolean flags in connectionStore with explicit states.
 *
 * @module Hooks/usePresence
 * @category Hooks
 */
import { useCallback, useMemo } from 'react'
import { useSelector } from '@xstate/react'
import { usePresenceContext } from '../provider/PresenceContext'
import {
  getPresenceShowFromState,
  getPresenceStatusFromState,
  isAutoAwayState,
  getConnectedStateName,
  type UserPresenceShow,
  type AutoAwaySavedState,
  type PresenceStateValue,
  type AutoAwayConfig,
} from '../core/presenceMachine'
import type { PresenceStatus, PresenceShow } from '../core/types'

/**
 * Return type for the usePresence hook.
 */
export interface UsePresenceReturn {
  // State
  /** Current presence status for UI display (online/away/dnd/offline) */
  presenceStatus: PresenceStatus
  /** Current XMPP show value (undefined=online, 'away', 'dnd', 'xa') */
  presenceShow: PresenceShow | undefined
  /** Current status message */
  statusMessage: string | null
  /** Whether currently in an auto-triggered away state */
  isAutoAway: boolean
  /** The state saved before entering auto-away (for restoration).
   *  Only 'online' or 'away' - never 'dnd' since DND blocks auto-away. */
  preAutoAwayState: AutoAwaySavedState | null
  /** User's last explicit presence preference (preserved across disconnects) */
  lastUserPreference: UserPresenceShow
  /** Detailed state name for debugging */
  stateName: string | null
  /** When user became idle (for XEP-0319) */
  idleSince: Date | null
  /** Auto-away configuration (idle threshold, check interval, enabled) */
  autoAwayConfig: AutoAwayConfig

  // Actions
  /** Set presence to online (with optional status message) */
  setOnline: (status?: string) => void
  /** Set presence to away (with optional status message) */
  setAway: (status?: string) => void
  /** Set presence to DND (with optional status message) */
  setDnd: (status?: string) => void
  /** Set presence by show value */
  setPresence: (show: UserPresenceShow, status?: string) => void
  /** Update auto-away configuration (partial updates allowed) */
  setAutoAwayConfig: (config: Partial<AutoAwayConfig>) => void

  // Events for auto-away system
  /** Notify machine that connection was established */
  connect: () => void
  /** Notify machine that connection was lost */
  disconnect: () => void
  /** Notify machine that user went idle */
  idleDetected: (since: Date) => void
  /** Notify machine that user activity was detected */
  activityDetected: () => void
  /** Notify machine that system is going to sleep */
  sleepDetected: () => void
  /** Notify machine that system woke from sleep */
  wakeDetected: () => void
}

/**
 * Hook for managing user presence state.
 *
 * Uses XState to provide explicit, auditable state transitions for presence.
 * Replaces the error-prone boolean flags (isAutoAway, savedPresenceShow, etc.)
 * with a proper state machine.
 *
 * @example Basic usage
 * ```tsx
 * function PresenceSelector() {
 *   const { presenceStatus, setOnline, setAway, setDnd } = usePresence()
 *
 *   return (
 *     <div>
 *       <span>Status: {presenceStatus}</span>
 *       <button onClick={() => setOnline()}>Online</button>
 *       <button onClick={() => setAway()}>Away</button>
 *       <button onClick={() => setDnd()}>Do Not Disturb</button>
 *     </div>
 *   )
 * }
 * ```
 *
 * @example Auto-away integration
 * ```tsx
 * declare function getIdleTime(): number
 *
 * function AutoAwayManager() {
 *   const { idleDetected, activityDetected, isAutoAway } = usePresence()
 *
 *   useEffect(() => {
 *     const checkIdle = setInterval(() => {
 *       if (getIdleTime() > 5 * 60 * 1000) {
 *         idleDetected(new Date(Date.now() - getIdleTime()))
 *       }
 *     }, 30000)
 *
 *     const handleActivity = () => activityDetected()
 *     document.addEventListener('mousemove', handleActivity)
 *
 *     return () => {
 *       clearInterval(checkIdle)
 *       document.removeEventListener('mousemove', handleActivity)
 *     }
 *   }, [idleDetected, activityDetected])
 *
 *   return null
 * }
 * ```
 *
 * @returns Presence state and actions
 * @category Hooks
 */
export function usePresence(): UsePresenceReturn {
  const { presenceActor } = usePresenceContext()

  // Select state value using XState's useSelector for efficient updates
  const stateValue = useSelector(presenceActor, (state) => state.value as PresenceStateValue)

  // Select individual context properties to avoid re-renders when unrelated properties change.
  // This prevents render loops that can occur when the entire context object is selected.
  const statusMessage = useSelector(presenceActor, (state) => state.context.statusMessage)
  const preAutoAwayState = useSelector(presenceActor, (state) => state.context.preAutoAwayState)
  const lastUserPreference = useSelector(presenceActor, (state) => state.context.lastUserPreference)
  const idleSince = useSelector(presenceActor, (state) => state.context.idleSince)
  const autoAwayConfig = useSelector(presenceActor, (state) => state.context.autoAwayConfig)

  // Derive values from state
  const presenceStatus = useMemo(
    () => getPresenceStatusFromState(stateValue),
    [stateValue]
  )

  const presenceShow = useMemo(
    () => getPresenceShowFromState(stateValue),
    [stateValue]
  )

  const isAutoAway = useMemo(
    () => isAutoAwayState(stateValue),
    [stateValue]
  )

  const stateName = useMemo(
    () => getConnectedStateName(stateValue),
    [stateValue]
  )

  // Actions that send events to the machine
  const setPresence = useCallback((show: UserPresenceShow, status?: string) => {
    presenceActor.send({ type: 'SET_PRESENCE', show, status })
  }, [presenceActor])

  const setOnline = useCallback((status?: string) => {
    presenceActor.send({ type: 'SET_PRESENCE', show: 'online', status })
  }, [presenceActor])

  const setAway = useCallback((status?: string) => {
    presenceActor.send({ type: 'SET_PRESENCE', show: 'away', status })
  }, [presenceActor])

  const setDnd = useCallback((status?: string) => {
    presenceActor.send({ type: 'SET_PRESENCE', show: 'dnd', status })
  }, [presenceActor])

  const connect = useCallback(() => {
    presenceActor.send({ type: 'CONNECT' })
  }, [presenceActor])

  const disconnect = useCallback(() => {
    presenceActor.send({ type: 'DISCONNECT' })
  }, [presenceActor])

  const idleDetected = useCallback((since: Date) => {
    presenceActor.send({ type: 'IDLE_DETECTED', since })
  }, [presenceActor])

  const activityDetected = useCallback(() => {
    presenceActor.send({ type: 'ACTIVITY_DETECTED' })
  }, [presenceActor])

  const sleepDetected = useCallback(() => {
    presenceActor.send({ type: 'SLEEP_DETECTED' })
  }, [presenceActor])

  const wakeDetected = useCallback(() => {
    presenceActor.send({ type: 'WAKE_DETECTED' })
  }, [presenceActor])

  const setAutoAwayConfig = useCallback((config: Partial<AutoAwayConfig>) => {
    presenceActor.send({ type: 'SET_AUTO_AWAY_CONFIG', config })
  }, [presenceActor])

  // Memoize actions object to prevent re-renders when only state changes
  const actions = useMemo(
    () => ({
      setOnline,
      setAway,
      setDnd,
      setPresence,
      setAutoAwayConfig,
      connect,
      disconnect,
      idleDetected,
      activityDetected,
      sleepDetected,
      wakeDetected,
    }),
    [setOnline, setAway, setDnd, setPresence, setAutoAwayConfig, connect, disconnect, idleDetected, activityDetected, sleepDetected, wakeDetected]
  )

  // Memoize the entire return value to prevent render loops
  return useMemo(
    () => ({
      // State
      presenceStatus,
      presenceShow,
      statusMessage,
      isAutoAway,
      preAutoAwayState,
      lastUserPreference,
      stateName,
      idleSince,
      autoAwayConfig,

      // Actions (spread memoized actions)
      ...actions,
    }),
    [presenceStatus, presenceShow, statusMessage, isAutoAway, preAutoAwayState, lastUserPreference, stateName, idleSince, autoAwayConfig, actions]
  )
}
