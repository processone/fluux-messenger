import { useEffect, useState, useRef } from 'react'
import {
  subscribeToDragState,
  subscribeToFileDrop,
  getIsDragging,
  getIsTauri,
} from '@/utils/tauriFileDrop'

/**
 * Hook for handling file drops in Tauri using the native onDragDropEvent API.
 * This is needed because Tauri 2.0 intercepts drag events before they reach
 * the webview's HTML5 drag-drop handlers.
 *
 * Uses a global listener that's set up immediately when the app loads,
 * so the drop zone is ready before React renders.
 *
 * @param onFileDrop - Callback when file(s) are dropped
 * @param enabled - Whether drop handling is enabled
 */
export function useTauriFileDrop(
  onFileDrop: (paths: string[]) => void,
  enabled: boolean = true
) {
  // Initialize with current global state (may already be dragging)
  const [isDragging, setIsDragging] = useState(getIsDragging)
  const onFileDropRef = useRef(onFileDrop)
  const isTauri = getIsTauri()

  // Keep ref updated to avoid stale closures
  useEffect(() => {
    onFileDropRef.current = onFileDrop
  }, [onFileDrop])

  // Subscribe to global drag state and file drop events
  useEffect(() => {
    if (!isTauri || !enabled) return

    const unsubscribeDrag = subscribeToDragState(setIsDragging)
    const unsubscribeDrop = subscribeToFileDrop((paths) => {
      onFileDropRef.current(paths)
    })

    return () => {
      unsubscribeDrag()
      unsubscribeDrop()
    }
  }, [isTauri, enabled])

  const resetDragging = () => {
    setIsDragging(false)
  }

  return {
    isDragging: isTauri ? isDragging : false,
    isTauri,
    resetDragging,
  }
}
