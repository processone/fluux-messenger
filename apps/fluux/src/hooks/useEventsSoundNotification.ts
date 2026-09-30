import { useEffect, useRef } from 'react'
import { useEvents, usePresence } from '@fluux/sdk'
import { useSettingsStore } from '@/stores/settingsStore'
import { contactRequestEventKey } from '@/utils/actionableEventNotification'
import { currentAccountId } from '@/utils/nativeNotification'
import { notifiedEventMemory } from '@/utils/notifiedEventMemory'

/**
 * Creates a notification sound for events using Web Audio API.
 * Generates a softer, rising two-tone sound to distinguish from message notifications.
 */
function createEventsNotificationSound(): () => void {
  let audioContext: AudioContext | null = null

  return () => {
    if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') {
      return
    }

    try {
      // Create or reuse AudioContext
      if (!audioContext) {
        audioContext = new window.AudioContext()
      }

      // Resume if suspended (required after user interaction)
      if (audioContext.state === 'suspended') {
        void audioContext.resume().catch(() => {
          // Some browsers may reject resume() until user gesture is trusted
        })
      }

      const now = audioContext.currentTime

      // First tone (lower pitch)
      const osc1 = audioContext.createOscillator()
      const gain1 = audioContext.createGain()
      osc1.connect(gain1)
      gain1.connect(audioContext.destination)
      osc1.frequency.value = 440 // A4
      osc1.type = 'sine'
      gain1.gain.setValueAtTime(0.2, now)
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.12)
      osc1.start(now)
      osc1.stop(now + 0.12)

      // Second tone (higher, rising effect)
      const osc2 = audioContext.createOscillator()
      const gain2 = audioContext.createGain()
      osc2.connect(gain2)
      gain2.connect(audioContext.destination)
      osc2.frequency.value = 554 // C#5
      osc2.type = 'sine'
      gain2.gain.setValueAtTime(0, now + 0.1)
      gain2.gain.linearRampToValueAtTime(0.2, now + 0.12)
      gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.25)
      osc2.start(now + 0.1)
      osc2.stop(now + 0.25)
    } catch {
      // Web Audio API not available or blocked
    }
  }
}

/**
 * Hook to play a sound notification for new events (subscription requests).
 *
 * The events store is not persisted and the server redelivers every pending
 * request at each login, so a request the user was already alerted to (in an
 * earlier session) stays silent while its per-account sound record is retained
 * by notifiedEventMemory.
 */
export function useEventsSoundNotification(): void {
  const { subscriptionRequests } = useEvents()
  const { presenceStatus } = usePresence()
  const soundEnabled = useSettingsStore((s) => s.soundEnabled)
  // Requests already present at mount are not new.
  const observedRef = useRef<Set<string> | null>(null)
  const playSoundRef = useRef<(() => void) | null>(null)

  // Initialize sound player
  useEffect(() => {
    if (typeof window !== 'undefined' && typeof window.AudioContext !== 'undefined') {
      playSoundRef.current = createEventsNotificationSound()
    }

    return () => {
      playSoundRef.current = null
    }
  }, [])

  // Watch for new subscription requests
  useEffect(() => {
    const account = currentAccountId()
    const memory = account ? notifiedEventMemory(account, 'sound') : null
    const current = new Set(subscriptionRequests.map((request) => contactRequestEventKey(request.from)))
    const observed = observedRef.current
    observedRef.current = current
    if (!observed) return

    for (const key of observed) {
      if (!current.has(key)) memory?.forget(key)
    }

    // Suppressed during DND or when sound is disabled
    if (presenceStatus === 'dnd' || !soundEnabled) return

    let alert = false
    for (const key of current) {
      if (observed.has(key) || memory?.has(key)) continue
      memory?.remember(key)
      alert = true
    }
    if (alert) playSoundRef.current?.()
  }, [subscriptionRequests, presenceStatus, soundEnabled])
}
