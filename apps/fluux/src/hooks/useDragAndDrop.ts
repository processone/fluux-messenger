import { useState, useRef, useCallback } from 'react'
import { useTauriFileDrop } from './useTauriFileDrop'
import { getMimeType, getFilename } from '@/utils/fileUtils'

interface UseDragAndDropOptions {
  /** Callback when a file is dropped (receives File object) */
  onFileDrop: (file: File) => Promise<void>
  /** Whether file upload is supported/enabled */
  isUploadSupported: boolean
}

interface DragHandlers {
  onDragEnter: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}

interface UseDragAndDropReturn {
  /** Whether a file is currently being dragged over the drop zone */
  isDragging: boolean
  /** Handlers to spread on the drop zone container */
  dragHandlers: DragHandlers
}

/**
 * Hook for handling file drag-and-drop in both web browser and Tauri desktop app.
 *
 * Features:
 * - HTML5 drag-and-drop for web browsers
 * - Tauri native file drop for desktop (converts file paths to File objects)
 * - Automatic detection of Tauri vs browser environment
 * - Drag counter to handle nested elements correctly
 *
 * @example
 * ```tsx
 * const { isDragging, dragHandlers } = useDragAndDrop({
 *   onFileDrop: async (file) => {
 *     const attachment = await uploadFile(file)
 *     // ...
 *   },
 *   isUploadSupported: true,
 * })
 *
 * return (
 *   <div {...dragHandlers}>
 *     {isDragging && <DropOverlay />}
 *     {children}
 *   </div>
 * )
 * ```
 */
export function useDragAndDrop({
  onFileDrop,
  isUploadSupported,
}: UseDragAndDropOptions): UseDragAndDropReturn {
  // HTML5 drag-and-drop state (for web browser)
  const [isHtmlDragging, setIsHtmlDragging] = useState(false)
  const dragCounterRef = useRef(0)

  // Tauri file drop handler (converts file paths to File objects)
  const handleTauriFileDrop = useCallback(async (paths: string[]) => {
    if (!isUploadSupported || paths.length === 0) return

    try {
      // Dynamic import to avoid loading Tauri API in browser
      const { readFile } = await import('@tauri-apps/plugin-fs')
      const path = paths[0] // Single file for now
      const filename = getFilename(path)
      const contents = await readFile(path)
      const mimeType = getMimeType(filename)

      // Create File object from contents
      const file = new File([contents], filename, { type: mimeType })
      await onFileDrop(file)
    } catch (err) {
      console.error('[useDragAndDrop] Failed to read dropped file:', err)
    }
  }, [isUploadSupported, onFileDrop])

  // Tauri native file drop (for desktop app)
  const { isDragging: isTauriDragging, isTauri } = useTauriFileDrop(handleTauriFileDrop, isUploadSupported)

  // Combined drag state: use Tauri's native drag in desktop, HTML5 in browser
  const isDragging = isTauri ? isTauriDragging : isHtmlDragging

  // HTML5 Drag-and-drop handlers (for web browser only - Tauri intercepts these)
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++

    // Only show drop zone for external file drags (from filesystem)
    // When dragging from inside the browser (e.g., an image in a message), the dataTransfer
    // includes 'text/html' or 'text/uri-list' in addition to 'Files'
    // When dragging from the filesystem, it only has 'Files' (or similar file type)
    const types = Array.from(e.dataTransfer.types)
    const hasFiles = types.includes('Files')
    const isInternalDrag = types.includes('text/html') || types.includes('text/uri-list')

    if (hasFiles && !isInternalDrag && isUploadSupported && !isTauri) {
      setIsHtmlDragging(true)
    }
  }, [isUploadSupported, isTauri])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsHtmlDragging(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsHtmlDragging(false)

    // Only handle in browser - Tauri uses native drop handler
    if (!isTauri) {
      // Ignore internal drags (images dragged from within the app)
      const types = Array.from(e.dataTransfer.types)
      const isInternalDrag = types.includes('text/html') || types.includes('text/uri-list')
      if (isInternalDrag) return

      const files = e.dataTransfer.files
      if (files.length > 0 && isUploadSupported) {
        // Upload first file (single file upload for now)
        void onFileDrop(files[0])
      }
    }
  }, [isUploadSupported, isTauri, onFileDrop])

  return {
    isDragging,
    dragHandlers: {
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
    },
  }
}
