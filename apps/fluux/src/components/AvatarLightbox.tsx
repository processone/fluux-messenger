/**
 * Full-screen lightbox overlay for viewing avatars at a larger size.
 * Triggered by clicking on a message avatar in chat/room views.
 */
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Avatar } from './Avatar'
import { useCloseOnEscape } from '@/hooks/useCloseOnEscape'

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
  const { t } = useTranslation()

  useCloseOnEscape(onClose)

  return createPortal(
    <div
      className="fixed inset-0 bg-black/70 flex flex-col items-center justify-center z-50"
    >
      {/* Click-outside-to-close backdrop (Escape also closes; see effect above) */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        aria-label={t('common.close')}
        className="absolute top-4 end-4 z-10 p-2 text-white/70 hover:text-white rounded-full hover:bg-white/10 transition-colors"
      >
        <X className="size-6" />
      </button>

      {/* Avatar */}
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={name || identifier}
          className="relative z-10 size-48 rounded-full object-cover shadow-2xl"
          draggable={false}
        />
      ) : (
        <div className="relative z-10">
          <Avatar
            identifier={identifier}
            name={name}
            size="xl"
            fallbackColor={fallbackColor}
          />
        </div>
      )}

      {/* Name label */}
      {name && (
        <div className="relative z-10 mt-3 text-white text-lg font-medium">
          {name}
        </div>
      )}
    </div>,
    document.body
  )
}
