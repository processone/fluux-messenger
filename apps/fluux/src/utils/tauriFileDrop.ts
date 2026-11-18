/**
 * Global Tauri file drop manager.
 *
 * Sets up the drag-drop listener IMMEDIATELY when the module loads,
 * so it's ready before any React components render.
 */

import { platform } from '@/platform'

type DragStateListener = (isDragging: boolean) => void
type FileDropListener = (paths: string[]) => void
type ConversationDropListener = (conversationId: string, paths: string[]) => void

/** Attribute that marks a sidebar conversation row. */
const CONVERSATION_ROW = '[data-conv-id]'

// Evaluate once at module load time
const isRunningInTauri = platform().nativeFileDrop

// Global state
let isDragging = false
const dragStateListeners = new Set<DragStateListener>()
const fileDropListeners = new Set<FileDropListener>()
const conversationDropListeners = new Set<ConversationDropListener>()

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

/**
 * The conversation row under a native drop. The page is laid out in CSS
 * pixels. macOS and Linux report the position in those logical units already;
 * only Windows reports physical pixels, which the display scale converts.
 */
export function conversationAtPosition(position: { x: number; y: number } | undefined): string | undefined {
  if (!position || typeof document === 'undefined') return undefined
  const scale = platform().os === 'windows' ? window.devicePixelRatio || 1 : 1
  const row = document.elementFromPoint(position.x / scale, position.y / scale)?.closest(CONVERSATION_ROW)
  return row?.getAttribute('data-conv-id') ?? undefined
}

/** A drop on a conversation row goes to the row; any other drop goes to the open chat. */
export function dispatchNativeDrop(paths: string[], position?: { x: number; y: number }) {
  const conversationId = conversationAtPosition(position)
  if (conversationId && conversationDropListeners.size > 0) {
    conversationDropListeners.forEach(listener => listener(conversationId, paths))
    return
  }
  notifyFileDrop(paths)
}

// Set up the global listener IMMEDIATELY (not in useEffect)
if (isRunningInTauri) {
  // Use dynamic import but start it immediately
  import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => {
    getCurrentWebview().onDragDropEvent((event) => {
      const { type, paths, position } = event.payload as {
        type: 'enter' | 'over' | 'drop' | 'leave'
        paths?: string[]
        position?: { x: number; y: number }
      }

      if (type === 'enter' || type === 'over') {
        notifyDragState(true)
      } else if (type === 'leave') {
        notifyDragState(false)
      } else if (type === 'drop') {
        notifyDragState(false)
        if (paths && paths.length > 0) {
          dispatchNativeDrop(paths, position)
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
 * Subscribe to files dropped on a conversation row of the sidebar.
 * While anyone is subscribed, such a drop does not reach the open chat.
 */
export function subscribeToConversationDrop(listener: ConversationDropListener): () => void {
  conversationDropListeners.add(listener)
  return () => conversationDropListeners.delete(listener)
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
export function hasNativeFileDrop(): boolean {
  return isRunningInTauri
}
