import { useEffect, useRef, useCallback } from 'react'
import { useNotificationEvents } from './useNotificationEvents'

/**
 * Creates a notification sound using Web Audio API.
 * Generates a pleasant two-tone "ding" sound.
 */
function createNotificationSound(): () => void {
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

      // First tone (higher pitch)
      const osc1 = audioContext.createOscillator()
      const gain1 = audioContext.createGain()
      osc1.connect(gain1)
      gain1.connect(audioContext.destination)
      osc1.frequency.value = 830 // G#5
      osc1.type = 'sine'
      gain1.gain.setValueAtTime(0.3, now)
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15)
      osc1.start(now)
      osc1.stop(now + 0.15)

      // Second tone (slightly lower, delayed)
      const osc2 = audioContext.createOscillator()
      const gain2 = audioContext.createGain()
      osc2.connect(gain2)
      gain2.connect(audioContext.destination)
      osc2.frequency.value = 622 // D#5
      osc2.type = 'sine'
      gain2.gain.setValueAtTime(0, now + 0.08)
      gain2.gain.linearRampToValueAtTime(0.25, now + 0.1)
      gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.3)
      osc2.start(now + 0.08)
      osc2.stop(now + 0.3)
    } catch {
      // Web Audio API not available or blocked
    }
  }
}

/**
 * Hook to play a sound notification for new messages and room mentions.
 * Uses the shared useNotificationEvents hook for detection logic.
 */
export function useSoundNotification(): void {
  const playSoundRef = useRef<(() => void) | null>(null)

  // Initialize sound player
  useEffect(() => {
    if (typeof window !== 'undefined' && typeof window.AudioContext !== 'undefined') {
      playSoundRef.current = createNotificationSound()
    }

    return () => {
      playSoundRef.current = null
    }
  }, [])

  const playSound = useCallback(() => {
    playSoundRef.current?.()
  }, [])

  // Subscribe to notification events
  useNotificationEvents({
    onConversationMessage: playSound,
    onRoomMessage: playSound,
  })
}
