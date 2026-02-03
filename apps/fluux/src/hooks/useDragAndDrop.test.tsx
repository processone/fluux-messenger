import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDragAndDrop } from './useDragAndDrop'

// Mock useTauriFileDrop
vi.mock('./useTauriFileDrop', () => ({
  useTauriFileDrop: vi.fn(() => ({ isDragging: false, isTauri: false })),
}))

// Mock file utilities
vi.mock('@/utils/fileUtils', () => ({
  getMimeType: vi.fn((filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase()
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'png') return 'image/png'
    return 'application/octet-stream'
  }),
  getFilename: vi.fn((path: string) => path.split('/').pop() || 'file'),
}))

import { useTauriFileDrop } from './useTauriFileDrop'

const mockUseTauriFileDrop = vi.mocked(useTauriFileDrop)

function createDragEvent(type: string, files: File[] = []): React.DragEvent {
  const dataTransfer = {
    types: files.length > 0 ? ['Files'] : [],
    files: files as unknown as FileList,
  }
  return {
    type,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer,
  } as unknown as React.DragEvent
}

describe('useDragAndDrop', () => {
  const mockOnFileDrop = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.clearAllMocks()
    mockUseTauriFileDrop.mockReturnValue({ isDragging: false, isTauri: false, resetDragging: vi.fn() })
  })

  describe('initialization', () => {
    it('should return isDragging as false initially', () => {
      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: true })
      )

      expect(result.current.isDragging).toBe(false)
    })

    it('should return drag handlers', () => {
      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: true })
      )

      expect(result.current.dragHandlers).toHaveProperty('onDragEnter')
      expect(result.current.dragHandlers).toHaveProperty('onDragLeave')
      expect(result.current.dragHandlers).toHaveProperty('onDragOver')
      expect(result.current.dragHandlers).toHaveProperty('onDrop')
    })
  })

  describe('HTML5 drag-and-drop (browser)', () => {
    it('should set isDragging to true on dragEnter with files', () => {
      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: true })
      )

      const event = createDragEvent('dragenter', [new File([''], 'test.jpg')])

      act(() => {
        result.current.dragHandlers.onDragEnter(event)
      })

      expect(result.current.isDragging).toBe(true)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(event.stopPropagation).toHaveBeenCalled()
    })

    it('should not set isDragging if upload is not supported', () => {
      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: false })
      )

      const event = createDragEvent('dragenter', [new File([''], 'test.jpg')])

      act(() => {
        result.current.dragHandlers.onDragEnter(event)
      })

      expect(result.current.isDragging).toBe(false)
    })

    it('should handle nested dragEnter/dragLeave correctly', () => {
      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: true })
      )

      const enterEvent = createDragEvent('dragenter', [new File([''], 'test.jpg')])
      const leaveEvent = createDragEvent('dragleave')

      // Enter parent
      act(() => {
        result.current.dragHandlers.onDragEnter(enterEvent)
      })
      expect(result.current.isDragging).toBe(true)

      // Enter child (nested)
      act(() => {
        result.current.dragHandlers.onDragEnter(enterEvent)
      })
      expect(result.current.isDragging).toBe(true)

      // Leave child
      act(() => {
        result.current.dragHandlers.onDragLeave(leaveEvent)
      })
      expect(result.current.isDragging).toBe(true) // Still dragging

      // Leave parent
      act(() => {
        result.current.dragHandlers.onDragLeave(leaveEvent)
      })
      expect(result.current.isDragging).toBe(false)
    })

    it('should call preventDefault on dragOver', () => {
      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: true })
      )

      const event = createDragEvent('dragover')

      act(() => {
        result.current.dragHandlers.onDragOver(event)
      })

      expect(event.preventDefault).toHaveBeenCalled()
      expect(event.stopPropagation).toHaveBeenCalled()
    })

    it('should call onFileDrop and reset state on drop', async () => {
      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: true })
      )

      const file = new File(['test content'], 'test.jpg', { type: 'image/jpeg' })
      const enterEvent = createDragEvent('dragenter', [file])
      const dropEvent = createDragEvent('drop', [file])

      // Start dragging
      act(() => {
        result.current.dragHandlers.onDragEnter(enterEvent)
      })
      expect(result.current.isDragging).toBe(true)

      // Drop
      act(() => {
        result.current.dragHandlers.onDrop(dropEvent)
      })

      expect(result.current.isDragging).toBe(false)
      expect(mockOnFileDrop).toHaveBeenCalledWith(file)
      expect(dropEvent.preventDefault).toHaveBeenCalled()
      expect(dropEvent.stopPropagation).toHaveBeenCalled()
    })

    it('should not call onFileDrop if upload is not supported', () => {
      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: false })
      )

      const file = new File(['test content'], 'test.jpg', { type: 'image/jpeg' })
      const dropEvent = createDragEvent('drop', [file])

      act(() => {
        result.current.dragHandlers.onDrop(dropEvent)
      })

      expect(mockOnFileDrop).not.toHaveBeenCalled()
    })

    it('should not call onFileDrop if no files are dropped', () => {
      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: true })
      )

      const dropEvent = createDragEvent('drop', [])

      act(() => {
        result.current.dragHandlers.onDrop(dropEvent)
      })

      expect(mockOnFileDrop).not.toHaveBeenCalled()
    })
  })

  describe('Tauri integration', () => {
    it('should use Tauri drag state when in Tauri environment', () => {
      mockUseTauriFileDrop.mockReturnValue({ isDragging: true, isTauri: true, resetDragging: vi.fn() })

      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: true })
      )

      expect(result.current.isDragging).toBe(true)
    })

    it('should not set HTML dragging state in Tauri environment', () => {
      mockUseTauriFileDrop.mockReturnValue({ isDragging: false, isTauri: true, resetDragging: vi.fn() })

      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: true })
      )

      const event = createDragEvent('dragenter', [new File([''], 'test.jpg')])

      act(() => {
        result.current.dragHandlers.onDragEnter(event)
      })

      // Should remain false because we're in Tauri and use native drag
      expect(result.current.isDragging).toBe(false)
    })

    it('should not call onFileDrop from HTML drop in Tauri environment', () => {
      mockUseTauriFileDrop.mockReturnValue({ isDragging: false, isTauri: true, resetDragging: vi.fn() })

      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: true })
      )

      const file = new File(['test content'], 'test.jpg', { type: 'image/jpeg' })
      const dropEvent = createDragEvent('drop', [file])

      act(() => {
        result.current.dragHandlers.onDrop(dropEvent)
      })

      // Should not call because Tauri handles drops natively
      expect(mockOnFileDrop).not.toHaveBeenCalled()
    })
  })

  describe('drag counter reset', () => {
    it('should reset drag counter on drop', () => {
      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: mockOnFileDrop, isUploadSupported: true })
      )

      const enterEvent = createDragEvent('dragenter', [new File([''], 'test.jpg')])
      const dropEvent = createDragEvent('drop', [new File([''], 'test.jpg')])
      const leaveEvent = createDragEvent('dragleave')

      // Enter multiple times (simulating nested elements)
      act(() => {
        result.current.dragHandlers.onDragEnter(enterEvent)
        result.current.dragHandlers.onDragEnter(enterEvent)
        result.current.dragHandlers.onDragEnter(enterEvent)
      })

      // Drop resets counter
      act(() => {
        result.current.dragHandlers.onDrop(dropEvent)
      })

      expect(result.current.isDragging).toBe(false)

      // Additional leave events should not cause issues
      act(() => {
        result.current.dragHandlers.onDragLeave(leaveEvent)
      })

      expect(result.current.isDragging).toBe(false)
    })
  })

  describe('upload-on-send privacy protection', () => {
    /**
     * These tests verify the critical privacy protection behavior:
     * Files are staged locally on drop, but NOT uploaded to the server.
     * The actual upload only happens when the user explicitly clicks Send.
     *
     * This prevents accidental data leakage if someone drags a file over
     * the window by mistake.
     */

    it('should accept sync onFileDrop callback (no async upload on drop)', () => {
      // The onFileDrop callback is now sync - it only stages the file locally
      // If it were async, that would indicate upload is happening immediately
      const syncStageFile = vi.fn() // Simulates ChatView's handleFileDrop which just sets state

      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: syncStageFile, isUploadSupported: true })
      )

      const file = new File(['sensitive data'], 'secret-document.pdf', { type: 'application/pdf' })
      const dropEvent = createDragEvent('drop', [file])

      act(() => {
        result.current.dragHandlers.onDrop(dropEvent)
      })

      // Callback was called synchronously with the file
      expect(syncStageFile).toHaveBeenCalledWith(file)
      expect(syncStageFile).toHaveBeenCalledTimes(1)
    })

    it('should also accept async onFileDrop callback (for flexibility)', () => {
      // Some use cases might still want async callbacks (e.g., Tauri file reading)
      const asyncCallback = vi.fn().mockResolvedValue(undefined)

      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop: asyncCallback, isUploadSupported: true })
      )

      const file = new File(['test'], 'file.pdf', { type: 'application/pdf' })
      const dropEvent = createDragEvent('drop', [file])

      act(() => {
        result.current.dragHandlers.onDrop(dropEvent)
      })

      expect(asyncCallback).toHaveBeenCalledWith(file)
    })

    it('should not leak file data when user drags over and then away', () => {
      // User accidentally drags file over window, then drags away without dropping
      const onFileDrop = vi.fn()

      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop, isUploadSupported: true })
      )

      const enterEvent = createDragEvent('dragenter', [new File(['secret'], 'secret.pdf')])
      const leaveEvent = createDragEvent('dragleave')

      // User drags over
      act(() => {
        result.current.dragHandlers.onDragEnter(enterEvent)
      })
      expect(result.current.isDragging).toBe(true)

      // User drags away without dropping
      act(() => {
        result.current.dragHandlers.onDragLeave(leaveEvent)
      })
      expect(result.current.isDragging).toBe(false)

      // File callback was never invoked - no data touched the server
      expect(onFileDrop).not.toHaveBeenCalled()
    })

    it('should ignore internal drags from app content', () => {
      // When dragging an image from a message, it should not trigger file staging
      const onFileDrop = vi.fn()

      const { result } = renderHook(() =>
        useDragAndDrop({ onFileDrop, isUploadSupported: true })
      )

      // Internal drags include text/html or text/uri-list in addition to Files
      const internalDragEvent = {
        type: 'drop',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: {
          types: ['Files', 'text/html', 'text/uri-list'],
          files: [new File([''], 'image.jpg')] as unknown as FileList,
        },
      } as unknown as React.DragEvent

      act(() => {
        result.current.dragHandlers.onDrop(internalDragEvent)
      })

      // Internal drags are ignored - prevents confusing behavior
      expect(onFileDrop).not.toHaveBeenCalled()
    })
  })
})
