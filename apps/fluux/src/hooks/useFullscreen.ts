import { useState, useEffect } from 'react'

// Tauri detection
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Shared state to avoid multiple listeners
let sharedFullscreenState = false
let listenerCount = 0
let unlisten: (() => void) | undefined
let setupInProgress = false
let shouldCleanup = false
const listeners = new Set<(isFullscreen: boolean) => void>()

function notifyListeners(isFullscreen: boolean) {
  sharedFullscreenState = isFullscreen
  listeners.forEach((listener) => listener(isFullscreen))
}

async function setupFullscreenDetection() {
  if (!isTauri || unlisten || setupInProgress) return
  setupInProgress = true

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const currentWindow = getCurrentWindow()

    // Check initial fullscreen state
    const fullscreen = await currentWindow.isFullscreen()
    notifyListeners(fullscreen)

    // Listen for resize events (fires on fullscreen toggle)
    const fn = await currentWindow.onResized(async () => {
      const fullscreen = await currentWindow.isFullscreen()
      notifyListeners(fullscreen)
    })

    // If cleanup was requested during setup, immediately unlisten
    if (shouldCleanup) {
      fn()
      shouldCleanup = false
    } else {
      unlisten = fn
    }
  } finally {
    setupInProgress = false
  }
}

function cleanupFullscreenDetection() {
  if (setupInProgress) {
    // Request cleanup when setup completes
    shouldCleanup = true
  } else if (unlisten) {
    unlisten()
    unlisten = undefined
  }
}

/**
 * Hook that tracks whether the window is in fullscreen mode.
 * Uses a shared listener to avoid multiple event subscriptions.
 * Returns false in non-Tauri environments.
 */
export function useFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(sharedFullscreenState)

  useEffect(() => {
    if (!isTauri) return

    // Subscribe to fullscreen changes
    listeners.add(setIsFullscreen)
    listenerCount++

    // Set up detection if this is the first subscriber
    if (listenerCount === 1) {
      void setupFullscreenDetection()
    }

    return () => {
      listeners.delete(setIsFullscreen)
      listenerCount--

      // Clean up if no more subscribers
      if (listenerCount === 0) {
        cleanupFullscreenDetection()
      }
    }
  }, [])

  return isFullscreen
}
