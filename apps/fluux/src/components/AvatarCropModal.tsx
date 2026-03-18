import React, { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Upload, ZoomIn, ZoomOut, RotateCcw, Camera, Video, VideoOff } from 'lucide-react'
import { Tooltip } from './Tooltip'

interface AvatarCropModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (imageData: Uint8Array, mimeType: string, width: number, height: number) => Promise<void>
}

const TARGET_SIZE = 256 // Output avatar size
const MIN_ZOOM = 1
const MAX_ZOOM = 3

export function AvatarCropModal({ isOpen, onClose, onSave }: AvatarCropModalProps) {
  const { t } = useTranslation()
  const [, setSelectedFile] = useState<File | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Webcam state
  const [webcamMode, setWebcamMode] = useState(false)
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null)
  const [webcamReady, setWebcamReady] = useState(false)

  // File drag-and-drop state
  const [isFileDragOver, setIsFileDragOver] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // Clean up URL when component unmounts or image changes
  useEffect(() => {
    return () => {
      if (imageUrl) {
        URL.revokeObjectURL(imageUrl)
      }
    }
  }, [imageUrl])

  // Stop webcam when modal closes or when switching modes
  const stopWebcam = () => {
    if (webcamStream) {
      webcamStream.getTracks().forEach(track => track.stop())
      setWebcamStream(null)
    }
    setWebcamReady(false)
  }

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedFile(null)
      setImageUrl(null)
      setZoom(1)
      setOffset({ x: 0, y: 0 })
      setError(null)
      setSaving(false)
      setWebcamMode(false)
      stopWebcam()
    }
  }, [isOpen, stopWebcam])

  // Check if webcam is available (requires secure context)
  const isWebcamAvailable = typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'

  // Start webcam
  const startWebcam = async () => {
    try {
      setError(null)

      // Check if mediaDevices API is available
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(t('avatar.webcamNotAvailable'))
        return
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' }
      })
      setWebcamStream(stream)
      setWebcamMode(true)
      // Note: video element setup is handled by useEffect below
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          setError(t('avatar.cameraAccessDenied'))
        } else if (err.name === 'NotFoundError') {
          setError(t('avatar.cameraNotFound'))
        } else {
          setError(t('avatar.cameraError'))
        }
      } else {
        setError(t('avatar.cameraError'))
      }
    }
  }

  // Set up video element when webcam stream is available
  // This runs after the video element is rendered (webcamMode triggers re-render)
  useEffect(() => {
    if (webcamMode && webcamStream && videoRef.current) {
      const video = videoRef.current
      video.srcObject = webcamStream
      video.onloadedmetadata = () => {
        video.play().catch(() => {
          // Autoplay may be blocked by browser policy - user can retry
          setError('Could not start webcam preview')
        })
        setWebcamReady(true)
      }
    }
  }, [webcamMode, webcamStream])

  // Capture photo from webcam
  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return

    const video = videoRef.current
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set canvas to video dimensions
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

    // Draw video frame to canvas (mirrored for selfie view)
    ctx.translate(canvas.width, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0) // Reset transform

    // Convert to blob URL
    canvas.toBlob((blob) => {
      if (blob) {
        if (imageUrl) {
          URL.revokeObjectURL(imageUrl)
        }
        const url = URL.createObjectURL(blob)
        setImageUrl(url)

        // Reset zoom/offset and stop webcam after capture
        setZoom(1)
        setOffset({ x: 0, y: 0 })
        stopWebcam()
        setWebcamMode(false)
      }
    }, 'image/jpeg', 0.9)
  }

  // Handle exiting webcam mode
  const exitWebcamMode = () => {
    stopWebcam()
    setWebcamMode(false)
  }

  // Process a file (shared by file input and drag-drop)
  const processFile = (file: File) => {
    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError(t('avatar.invalidFileType'))
      return
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setError(t('avatar.fileTooLarge'))
      return
    }

    setError(null)
    setSelectedFile(file)

    // Create preview URL
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl)
    }
    const url = URL.createObjectURL(file)
    setImageUrl(url)

    // Reset zoom and offset
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processFile(file)
  }

  // Drag-and-drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types.includes('Files')) {
      setIsFileDragOver(true)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set to false if leaving the drop zone (not entering a child)
    if (e.currentTarget === e.target) {
      setIsFileDragOver(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsFileDragOver(false)

    const file = e.dataTransfer.files?.[0]
    if (file) processFile(file)
  }

  // Unified pointer handling for mouse and touch
  const handlePointerDown = (e: React.PointerEvent) => {
    if (!imageUrl) return
    e.preventDefault()
    // Capture pointer to receive events even when cursor leaves element
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setIsDragging(true)
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y })
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return
    e.preventDefault()
    setOffset({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    })
  }

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isDragging) {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    }
    setIsDragging(false)
  }

  const handleZoomIn = () => {
    setZoom(z => Math.min(z + 0.25, MAX_ZOOM))
  }

  const handleZoomOut = () => {
    setZoom(z => Math.max(z - 0.25, MIN_ZOOM))
  }

  const handleReset = () => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

  const handleSave = async () => {
    if (!imageUrl || !canvasRef.current) return

    setSaving(true)
    setError(null)

    try {
      const canvas = canvasRef.current
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        setError('Canvas not supported')
        return
      }

      // Set canvas to target size
      canvas.width = TARGET_SIZE
      canvas.height = TARGET_SIZE

      // Load the image
      const img = new Image()
      img.crossOrigin = 'anonymous'

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Failed to load image'))
        img.src = imageUrl
      })

      // Calculate the crop area
      // The preview area is 200x200 (see previewRef), and the image is scaled to cover it
      // Math.max ensures the smaller dimension fills 200px (cover behavior)
      const previewSize = 200
      const scale = Math.max(previewSize / img.width, previewSize / img.height) * zoom

      // Center of the preview
      const centerX = previewSize / 2
      const centerY = previewSize / 2

      // The crop area in scaled coordinates
      const cropX = centerX - offset.x - previewSize / 2
      const cropY = centerY - offset.y - previewSize / 2

      // Convert to original image coordinates
      const srcX = (cropX / scale)
      const srcY = (cropY / scale)
      const srcSize = previewSize / scale

      // Clear canvas and draw
      ctx.fillStyle = '#313338'
      ctx.fillRect(0, 0, TARGET_SIZE, TARGET_SIZE)

      // Draw the cropped and scaled image
      ctx.drawImage(
        img,
        srcX, srcY, srcSize, srcSize,
        0, 0, TARGET_SIZE, TARGET_SIZE
      )

      // Export as JPEG (better compression for photos)
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => b ? resolve(b) : reject(new Error('Failed to create blob')),
          'image/jpeg',
          0.85
        )
      })

      // Convert blob to Uint8Array
      const arrayBuffer = await blob.arrayBuffer()
      const imageData = new Uint8Array(arrayBuffer)

      await onSave(imageData, 'image/jpeg', TARGET_SIZE, TARGET_SIZE)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save avatar')
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-fluux-sidebar rounded-lg shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-fluux-bg">
          <h2 className="text-lg font-semibold text-fluux-text">{t('avatar.uploadTitle')}</h2>
          <Tooltip content={t('common.close')}>
            <button
              onClick={onClose}
              className="p-1 text-fluux-muted hover:text-fluux-text rounded"
            >
              <X className="w-5 h-5" />
            </button>
          </Tooltip>
        </div>

        {/* Content */}
        <div className="p-4">
          {webcamMode ? (
            // Webcam capture mode
            <div className="flex flex-col items-center gap-4">
              {/* Webcam preview */}
              <div className="relative w-[200px] h-[200px] rounded-full overflow-hidden bg-fluux-bg">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="absolute w-full h-full object-cover"
                  style={{ transform: 'scaleX(-1)' }} // Mirror for selfie view
                />
                {!webcamReady && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-fluux-brand" />
                  </div>
                )}
              </div>

              {/* Webcam controls */}
              <div className="flex items-center gap-4">
                <button
                  onClick={capturePhoto}
                  disabled={!webcamReady}
                  className="flex items-center gap-2 px-4 py-2 bg-fluux-brand hover:bg-fluux-brand-hover text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Camera className="w-5 h-5" />
                  {t('avatar.takePhoto')}
                </button>
                <button
                  onClick={exitWebcamMode}
                  className="flex items-center gap-2 px-4 py-2 text-fluux-muted hover:text-fluux-text rounded transition-colors"
                >
                  <VideoOff className="w-5 h-5" />
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : !imageUrl ? (
            // Source selection
            <div className="flex flex-col gap-4">
              {/* File upload option with drag-drop */}
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                  isFileDragOver
                    ? 'border-fluux-brand bg-fluux-brand/10'
                    : 'border-fluux-muted/50 hover:border-fluux-brand'
                }`}
              >
                <Upload className={`w-10 h-10 mx-auto mb-2 ${isFileDragOver ? 'text-fluux-brand' : 'text-fluux-muted'}`} />
                <p className="text-fluux-text mb-1">
                  {isFileDragOver ? t('avatar.dropImageHere') : t('avatar.dragOrClick')}
                </p>
                <p className="text-sm text-fluux-muted">{t('avatar.acceptedFormats')} · {t('avatar.maxSize')}</p>
              </div>

              {/* Webcam option - only show if available */}
              {isWebcamAvailable && (
                <div
                  onClick={startWebcam}
                  className="border-2 border-dashed border-fluux-muted/50 rounded-lg p-6 text-center cursor-pointer hover:border-fluux-brand transition-colors"
                >
                  <Video className="w-10 h-10 mx-auto mb-2 text-fluux-muted" />
                  <p className="text-fluux-text mb-1">{t('avatar.useWebcam')}</p>
                  <p className="text-sm text-fluux-muted">{t('avatar.takePhotoDescription')}</p>
                </div>
              )}
            </div>
          ) : (
            // Crop preview
            <div className="flex flex-col items-center gap-4">
              {/* Preview area */}
              <div
                ref={previewRef}
                className={`relative w-[200px] h-[200px] rounded-full overflow-hidden bg-fluux-bg touch-none select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              >
                {(() => {
                  // Use object-fit approach similar to video element
                  // Scale the container size for zoom, use object-fit for aspect ratio
                  const baseSize = 200
                  const scaledSize = baseSize * zoom

                  return (
                    <img
                      src={imageUrl}
                      alt="Preview"
                      className="absolute pointer-events-none"
                      style={{
                        width: scaledSize,
                        height: scaledSize,
                        objectFit: 'cover',
                        left: '50%',
                        top: '50%',
                        transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                      }}
                      draggable={false}
                    />
                  )
                })()}
              </div>

              {/* Zoom controls */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleZoomOut}
                  disabled={zoom <= MIN_ZOOM}
                  className="p-2 text-fluux-muted hover:text-fluux-text disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ZoomOut className="w-5 h-5" />
                </button>
                <div className="w-32 h-1 bg-fluux-bg rounded-full overflow-hidden">
                  <div
                    className="h-full bg-fluux-brand transition-all"
                    style={{ width: `${((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100}%` }}
                  />
                </div>
                <button
                  onClick={handleZoomIn}
                  disabled={zoom >= MAX_ZOOM}
                  className="p-2 text-fluux-muted hover:text-fluux-text disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ZoomIn className="w-5 h-5" />
                </button>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-4">
                <Tooltip content={t('avatar.resetZoom')}>
                  <button
                    onClick={handleReset}
                    disabled={zoom === 1 && offset.x === 0 && offset.y === 0}
                    className="flex items-center gap-1 text-sm text-fluux-muted hover:text-fluux-text disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RotateCcw className="w-4 h-4" />
                    {t('avatar.reset')}
                  </button>
                </Tooltip>
                <button
                  onClick={() => {
                    if (imageUrl) URL.revokeObjectURL(imageUrl)
                    setImageUrl(null)
                  }}
                  className="text-sm text-fluux-link hover:underline"
                >
                  {t('avatar.chooseDifferentSource')}
                </button>
              </div>
            </div>
          )}

          {/* Hidden canvas for processing */}
          <canvas ref={canvasRef} className="hidden" />

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="hidden"
          />

          {/* Error message */}
          {error && (
            <p className="mt-3 text-sm text-fluux-red text-center">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-4 border-t border-fluux-bg">
          <button
            onClick={onClose}
            className="px-4 py-2 text-fluux-text hover:bg-fluux-hover rounded transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={!imageUrl || saving}
            className="px-4 py-2 bg-fluux-brand hover:bg-fluux-brand-hover text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
