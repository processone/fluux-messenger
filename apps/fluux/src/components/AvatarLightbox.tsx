/**
 * Full-screen lightbox overlay for viewing avatars at a larger size.
 * Triggered by clicking on a message avatar in chat/room views.
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Avatar } from './Avatar'

interface AvatarLightboxProps {
  /** Avatar image URL (if available) */
  avatarUrl?: string
  /** Identifier for consistent color fallback */
  identifier: string
  /** Display name */
  name?: string
  /** Custom fallback color for letter avatar */
  fallbackColor?: string
  /** Close handler */
  onClose: () => void
}

export function AvatarLightbox({ avatarUrl, identifier, name, fallbackColor, onClose }: AvatarLightboxProps) {
  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 bg-black/70 flex flex-col items-center justify-center z-50"
      onMouseDown={(e) => { mouseDownTargetRef.current = e.target }}
      onClick={(e) => {
        if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) onClose()
      }}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 end-4 p-2 text-white/70 hover:text-white rounded-full hover:bg-white/10 transition-colors"
      >
        <X className="w-6 h-6" />
      </button>

      {/* Avatar */}
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={name || identifier}
          className="w-48 h-48 rounded-full object-cover shadow-2xl"
          draggable={false}
        />
      ) : (
        <Avatar
          identifier={identifier}
          name={name}
          size="xl"
          fallbackColor={fallbackColor}
        />
      )}

      {/* Name label */}
      {name && (
        <div className="mt-3 text-white text-lg font-medium">
          {name}
        </div>
      )}
    </div>,
    document.body
  )
}
