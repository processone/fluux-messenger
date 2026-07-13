import { useState, useEffect, useCallback } from 'react'
import { isUpdaterEnabled } from '@/utils/tauri'
import { createDownloadProgressTracker, type UpdaterDownloadEvent } from './downloadProgressTracker'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// In-app updates are disabled on Linux - users update through their distro package manager
const updaterEnabled = isUpdaterEnabled()

// Cap download-progress re-renders to ~10/sec. The updater emits a Progress
// event per network chunk (hundreds/sec on a fast link); updating React state on
// every one re-rendered the whole tree past the render-loop detector threshold
// and broke the UI mid-download (issue #994).
const PROGRESS_UPDATE_INTERVAL_MS = 100

export interface UpdateState {
  available: boolean
  version: string | null
  releaseNotes: string | null
  checking: boolean
  downloading: boolean
  progress: number
  downloaded: boolean
  error: string | null
}

const initialState: UpdateState = {
  available: false,
  version: null,
  releaseNotes: null,
  checking: false,
  downloading: false,
  progress: 0,
  downloaded: false,
  error: null,
}

interface UseAutoUpdateOptions {
  /** Whether to automatically check for updates on mount. Default: false */
  autoCheck?: boolean
}

export function useAutoUpdate(options: UseAutoUpdateOptions = {}) {
  const { autoCheck = false } = options
  const [state, setState] = useState<UpdateState>(initialState)
  const [update, setUpdate] = useState<Awaited<ReturnType<typeof import('@tauri-apps/plugin-updater').check>> | null>(null)

  const checkForUpdate = useCallback(async () => {
    if (!updaterEnabled) return

    setState(prev => ({ ...prev, checking: true, error: null }))

    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const updateInfo = await check()

      if (updateInfo) {
        setUpdate(updateInfo)
        setState(prev => ({
          ...prev,
          available: true,
          version: updateInfo.version,
          releaseNotes: updateInfo.body || null,
          checking: false,
        }))
      } else {
        setState(prev => ({ ...prev, checking: false }))
      }
    } catch (err) {
      // Return translation keys for user-friendly error messages
      let errorKey = 'update.errorGeneric'
      if (err instanceof Error) {
        const msg = err.message.toLowerCase()
        if (msg.includes('404') || msg.includes('not found')) {
          errorKey = 'update.errorNoReleases'
        } else if (msg.includes('network') || msg.includes('fetch') || msg.includes('connect')) {
          errorKey = 'update.errorNetwork'
        }
      }
      setState(prev => ({
        ...prev,
        checking: false,
        error: errorKey,
      }))
    }
  }, [])

  const downloadAndInstall = async () => {
    if (!update) return

    setState(prev => ({ ...prev, downloading: true, progress: 0, error: null }))

    try {
      // Throttle the per-chunk Progress events so a fast download can't
      // re-render the app past the render-loop detector (issue #994).
      const tracker = createDownloadProgressTracker(PROGRESS_UPDATE_INTERVAL_MS)
      await update.downloadAndInstall((event) => {
        const progress = tracker.handle(event as UpdaterDownloadEvent)
        if (progress === null) return
        const finished = event.event === 'Finished'
        setState(prev => ({
          ...prev,
          progress,
          ...(finished ? { downloaded: true } : {}),
        }))
      })

      setState(prev => ({ ...prev, downloading: false, downloaded: true }))
    } catch (err) {
      setState(prev => ({
        ...prev,
        downloading: false,
        error: err instanceof Error ? err.message : 'Failed to download update',
      }))
    }
  }

  const relaunchApp = async () => {
    if (!updaterEnabled) return

    try {
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to relaunch app',
      }))
    }
  }

  const dismissUpdate = () => {
    setState(initialState)
    setUpdate(null)
  }

  // Check for updates on mount (only when autoCheck is enabled, typically at app launch)
  // Disabled on Linux - users update through their distro package manager
  useEffect(() => {
    if (updaterEnabled && autoCheck) {
      // Delay check slightly to not block app startup
      const timer = setTimeout(checkForUpdate, 2000)
      return () => clearTimeout(timer)
    }
  }, [checkForUpdate, autoCheck])

  return {
    ...state,
    checkForUpdate,
    downloadAndInstall,
    relaunchApp,
    dismissUpdate,
    isTauri,
    /** Whether in-app updates are enabled (Tauri on macOS/Windows, not Linux) */
    updaterEnabled,
  }
}
