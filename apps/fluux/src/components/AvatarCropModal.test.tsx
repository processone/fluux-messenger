import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { AvatarCropModal } from './AvatarCropModal'

// Mock URL API
const mockCreateObjectURL = vi.fn(() => 'blob:mock-url')
const mockRevokeObjectURL = vi.fn()

// Store originals for proper cleanup
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
const originalMediaDevices = navigator.mediaDevices

describe('AvatarCropModal', () => {
  const mockOnClose = vi.fn()
  const mockOnSave = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.clearAllMocks()

    // Setup URL mocks
    global.URL.createObjectURL = mockCreateObjectURL
    global.URL.revokeObjectURL = mockRevokeObjectURL

    // Mock mediaDevices as available by default
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(),
      },
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    // Ensure all components are unmounted before restoring globals
    cleanup()
    vi.restoreAllMocks()
    // Restore globals that vi.restoreAllMocks doesn't handle
    global.URL.createObjectURL = originalCreateObjectURL
    global.URL.revokeObjectURL = originalRevokeObjectURL
    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      configurable: true,
      writable: true,
    })
  })

  describe('rendering', () => {
    it('should not render when isOpen is false', () => {
      render(
        <AvatarCropModal isOpen={false} onClose={mockOnClose} onSave={mockOnSave} />
      )

      expect(screen.queryByText('avatar.uploadTitle')).not.toBeInTheDocument()
    })

    it('should render modal when isOpen is true', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      expect(screen.getByText('avatar.uploadTitle')).toBeInTheDocument()
      expect(screen.getByText('avatar.dragOrClick')).toBeInTheDocument()
    })

    it('should show file size limit in upload area', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      expect(screen.getByText(/avatar\.acceptedFormats/)).toBeInTheDocument()
    })

    it('should call onClose when Cancel button is clicked', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      fireEvent.click(screen.getAllByText('common.cancel')[0])
      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should have disabled Save button when no image is selected', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      const saveButton = screen.getByText('common.save')
      expect(saveButton).toBeDisabled()
    })
  })

  describe('file validation', () => {
    it('should reject non-image files', async () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      const file = new File(['test'], 'test.txt', { type: 'text/plain' })
      const input = document.querySelector('input[type="file"]') as HTMLInputElement

      fireEvent.change(input, { target: { files: [file] } })

      expect(screen.getByText('avatar.invalidFileType')).toBeInTheDocument()
    })

    it('should reject files larger than 5MB', async () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      // Create a mock file larger than 5MB
      const largeFile = new File(['x'], 'large.png', { type: 'image/png' })
      Object.defineProperty(largeFile, 'size', { value: 6 * 1024 * 1024 })

      const input = document.querySelector('input[type="file"]') as HTMLInputElement
      fireEvent.change(input, { target: { files: [largeFile] } })

      expect(screen.getByText('avatar.fileTooLarge')).toBeInTheDocument()
    })

    it('should accept valid PNG image files', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      const file = new File(['test'], 'avatar.png', { type: 'image/png' })
      const input = document.querySelector('input[type="file"]') as HTMLInputElement

      fireEvent.change(input, { target: { files: [file] } })

      expect(mockCreateObjectURL).toHaveBeenCalledWith(file)
      // No error should be displayed
      expect(screen.queryByText('avatar.invalidFileType')).not.toBeInTheDocument()
      expect(screen.queryByText('avatar.fileTooLarge')).not.toBeInTheDocument()
    })

    it('should accept valid JPEG image files', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      const file = new File(['test'], 'avatar.jpg', { type: 'image/jpeg' })
      const input = document.querySelector('input[type="file"]') as HTMLInputElement

      fireEvent.change(input, { target: { files: [file] } })

      expect(mockCreateObjectURL).toHaveBeenCalledWith(file)
    })

    it('should accept valid GIF image files', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      const file = new File(['test'], 'avatar.gif', { type: 'image/gif' })
      const input = document.querySelector('input[type="file"]') as HTMLInputElement

      fireEvent.change(input, { target: { files: [file] } })

      expect(mockCreateObjectURL).toHaveBeenCalledWith(file)
    })

    it('should accept valid WebP image files', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      const file = new File(['test'], 'avatar.webp', { type: 'image/webp' })
      const input = document.querySelector('input[type="file"]') as HTMLInputElement

      fireEvent.change(input, { target: { files: [file] } })

      expect(mockCreateObjectURL).toHaveBeenCalledWith(file)
    })
  })

  describe('drag and drop', () => {
    it('should show visual feedback on drag enter', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      const uploadArea = screen.getByText('avatar.dragOrClick').closest('div')!

      fireEvent.dragEnter(uploadArea, {
        dataTransfer: { types: ['Files'] },
      })

      expect(screen.getByText('avatar.dropImageHere')).toBeInTheDocument()
    })

    it('should process dropped image files', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      const file = new File(['test'], 'dropped.png', { type: 'image/png' })
      const uploadArea = screen.getByText('avatar.dragOrClick').closest('div')!

      fireEvent.drop(uploadArea, {
        dataTransfer: { files: [file] },
      })

      expect(mockCreateObjectURL).toHaveBeenCalledWith(file)
    })

    it('should reject dropped non-image files', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      const file = new File(['test'], 'document.pdf', { type: 'application/pdf' })
      const uploadArea = screen.getByText('avatar.dragOrClick').closest('div')!

      fireEvent.drop(uploadArea, {
        dataTransfer: { files: [file] },
      })

      expect(screen.getByText('avatar.invalidFileType')).toBeInTheDocument()
    })

    it('should reject dropped files larger than 5MB', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      const largeFile = new File(['x'], 'large.png', { type: 'image/png' })
      Object.defineProperty(largeFile, 'size', { value: 6 * 1024 * 1024 })

      const uploadArea = screen.getByText('avatar.dragOrClick').closest('div')!

      fireEvent.drop(uploadArea, {
        dataTransfer: { files: [largeFile] },
      })

      expect(screen.getByText('avatar.fileTooLarge')).toBeInTheDocument()
    })
  })

  describe('webcam availability', () => {
    it('should show webcam option when mediaDevices is available', () => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          getUserMedia: vi.fn(),
        },
        configurable: true,
        writable: true,
      })

      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      expect(screen.getByText('avatar.useWebcam')).toBeInTheDocument()
      expect(screen.getByText('avatar.takePhotoDescription')).toBeInTheDocument()
    })

    it('should hide webcam option when mediaDevices is unavailable', () => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: undefined,
        configurable: true,
        writable: true,
      })

      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      expect(screen.queryByText('avatar.useWebcam')).not.toBeInTheDocument()
    })

    it('should hide webcam option when getUserMedia is not a function', () => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {},
        configurable: true,
        writable: true,
      })

      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      expect(screen.queryByText('avatar.useWebcam')).not.toBeInTheDocument()
    })
  })

  describe('modal state reset', () => {
    it('should reset error state when modal closes and reopens', () => {
      const { rerender } = render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      // Trigger an error
      const file = new File(['test'], 'test.txt', { type: 'text/plain' })
      const input = document.querySelector('input[type="file"]') as HTMLInputElement
      fireEvent.change(input, { target: { files: [file] } })

      expect(screen.getByText('avatar.invalidFileType')).toBeInTheDocument()

      // Close modal
      rerender(
        <AvatarCropModal isOpen={false} onClose={mockOnClose} onSave={mockOnSave} />
      )

      // Reopen modal
      rerender(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      // Error should be cleared
      expect(screen.queryByText('avatar.invalidFileType')).not.toBeInTheDocument()
    })

    it('should revoke object URL when modal closes', () => {
      const { rerender } = render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      // Select a file to create an object URL
      const file = new File(['test'], 'avatar.png', { type: 'image/png' })
      const input = document.querySelector('input[type="file"]') as HTMLInputElement
      fireEvent.change(input, { target: { files: [file] } })

      expect(mockCreateObjectURL).toHaveBeenCalled()

      // Close modal
      rerender(
        <AvatarCropModal isOpen={false} onClose={mockOnClose} onSave={mockOnSave} />
      )

      // URL should be revoked
      expect(mockRevokeObjectURL).toHaveBeenCalled()
    })
  })

  describe('upload area click', () => {
    it('should trigger file input when upload area is clicked', () => {
      render(
        <AvatarCropModal isOpen={true} onClose={mockOnClose} onSave={mockOnSave} />
      )

      const input = document.querySelector('input[type="file"]') as HTMLInputElement
      const clickSpy = vi.spyOn(input, 'click')

      const uploadArea = screen.getByText('avatar.dragOrClick').closest('div')!
      fireEvent.click(uploadArea)

      expect(clickSpy).toHaveBeenCalled()
    })
  })
})
