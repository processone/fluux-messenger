import { useState, useEffect, useCallback } from 'react'
import { isUpdaterEnabled } from '@/utils/tauri'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// In-app updates are disabled on Linux - users update through their distro package manager
const updaterEnabled = isUpdaterEnabled()

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

  const downloadAndInstall = useCallback(async () => {
    if (!update) return

    setState(prev => ({ ...prev, downloading: true, progress: 0, error: null }))

    try {
      // Download with progress tracking
      let contentLength = 0
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = (event.data as { contentLength?: number }).contentLength || 0
            setState(prev => ({ ...prev, progress: 0 }))
            break
          case 'Progress':
            if (contentLength > 0) {
              const chunkLength = (event.data as { chunkLength: number }).chunkLength
              setState(prev => {
                const newProgress = Math.min(
                  prev.progress + (chunkLength / contentLength) * 100,
                  99
                )
                return { ...prev, progress: newProgress }
              })
            }
            break
          case 'Finished':
            setState(prev => ({ ...prev, progress: 100, downloaded: true }))
            break
        }
      })

      setState(prev => ({ ...prev, downloading: false, downloaded: true }))
    } catch (err) {
      setState(prev => ({
        ...prev,
        downloading: false,
        error: err instanceof Error ? err.message : 'Failed to download update',
      }))
    }
  }, [update])

  const relaunchApp = useCallback(async () => {
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
  }, [])

  const dismissUpdate = useCallback(() => {
    setState(initialState)
    setUpdate(null)
  }, [])

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
