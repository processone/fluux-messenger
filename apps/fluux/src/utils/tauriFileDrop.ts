/**
 * Global Tauri file drop manager.
 *
 * Sets up the drag-drop listener IMMEDIATELY when the module loads,
 * so it's ready before any React components render.
 */

import { isTauri } from './tauri'

type DragStateListener = (isDragging: boolean) => void
type FileDropListener = (paths: string[]) => void

// Evaluate once at module load time
const isRunningInTauri = isTauri()

// Global state
let isDragging = false
const dragStateListeners = new Set<DragStateListener>()
const fileDropListeners = new Set<FileDropListener>()

// Notify all listeners of drag state change
function notifyDragState(dragging: boolean) {
  if (isDragging === dragging) return
  isDragging = dragging
  dragStateListeners.forEach(listener => listener(dragging))
}

// Notify all listeners of file drop
function notifyFileDrop(paths: string[]) {
  fileDropListeners.forEach(listener => listener(paths))
}

// Set up the global listener IMMEDIATELY (not in useEffect)
if (isRunningInTauri) {
  // Use dynamic import but start it immediately
  import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => {
    getCurrentWebview().onDragDropEvent((event) => {
      const { type, paths } = event.payload as {
        type: 'enter' | 'over' | 'drop' | 'leave'
        paths?: string[]
      }

      if (type === 'enter' || type === 'over') {
        notifyDragState(true)
      } else if (type === 'leave') {
        notifyDragState(false)
      } else if (type === 'drop') {
        notifyDragState(false)
        if (paths && paths.length > 0) {
          notifyFileDrop(paths)
        }
      }
    }).catch(err => {
      console.error('[tauriFileDrop] Failed to setup listener:', err)
    })
  }).catch(err => {
    console.error('[tauriFileDrop] Failed to import Tauri API:', err)
  })
}

/**
 * Subscribe to drag state changes.
 * Returns an unsubscribe function.
 */
export function subscribeToDragState(listener: DragStateListener): () => void {
  dragStateListeners.add(listener)
  // Immediately notify of current state
  listener(isDragging)
  return () => dragStateListeners.delete(listener)
}

/**
 * Subscribe to file drop events.
 * Returns an unsubscribe function.
 */
export function subscribeToFileDrop(listener: FileDropListener): () => void {
  fileDropListeners.add(listener)
  return () => fileDropListeners.delete(listener)
}

/**
 * Get current drag state (for initial render).
 */
export function getIsDragging(): boolean {
  return isDragging
}

/**
 * Check if running in Tauri.
 */
export function getIsTauri(): boolean {
  return isRunningInTauri
}
