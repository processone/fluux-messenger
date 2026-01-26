import { useMemo, type ReactNode } from 'react'
import { generateConsistentColorHexSync, type PresenceStatus, type PresenceShow } from '@fluux/sdk'
import { PRESENCE_COLORS } from '@/constants/ui'

/**
 * Avatar sizes and their corresponding Tailwind classes
 */
const SIZES = {
  xs: { container: 'w-6 h-6', text: 'text-xs', presence: 'w-2 h-2 -bottom-0 -right-0' },
  sm: { container: 'w-8 h-8', text: 'text-sm', presence: 'w-3 h-3 -bottom-0.5 -right-0.5' },
  header: { container: 'w-9 h-9', text: 'text-base', presence: 'w-3 h-3 -bottom-0.5 -right-0.5' },
  md: { container: 'w-10 h-10', text: 'text-base', presence: 'w-3.5 h-3.5 -bottom-0.5 -right-0.5' },
  lg: { container: 'w-12 h-12', text: 'text-lg', presence: 'w-4 h-4 -bottom-0.5 -right-0.5' },
  xl: { container: 'w-24 h-24', text: 'text-3xl', presence: 'w-5 h-5 bottom-0 right-0' },
} as const

export type AvatarSize = keyof typeof SIZES

export interface AvatarProps {
  /**
   * Unique identifier used for consistent color generation (JID, nickname, etc.)
   * The same identifier always produces the same color.
   */
  identifier: string

  /**
   * Display name used for the fallback letter. Defaults to identifier.
   */
  name?: string

  /**
   * URL to the avatar image. If provided and valid, shows the image instead of the letter.
   */
  avatarUrl?: string

  /**
   * Avatar size preset.
   * @default 'sm'
   */
  size?: AvatarSize

  /**
   * Presence status to show as an indicator dot.
   * If not provided, no presence indicator is shown.
   */
  presence?: PresenceStatus

  /**
   * Presence show value (away, dnd, xa, chat) for more detailed status.
   * Used to determine the presence color when presence is 'online'.
   */
  presenceShow?: PresenceShow


  /**
   * Additional CSS classes to apply to the container.
   */
  className?: string

  /**
   * Click handler for the avatar.
   */
  onClick?: () => void

  /**
   * Whether the avatar is clickable (shows pointer cursor and hover effect).
   * Automatically true if onClick is provided.
   */
  clickable?: boolean

  /**
   * Border color class for the presence indicator.
   * @default 'border-fluux-sidebar'
   */
  presenceBorderColor?: string

  /**
   * Custom overlay content (e.g., typing indicator).
   * Replaces the presence indicator when provided.
   */
  overlay?: ReactNode

  /**
   * Custom fallback background color when no avatar image is present.
   * If provided, overrides the auto-generated color from identifier.
   * Useful for matching avatar color to nick text color in chat rooms.
   */
  fallbackColor?: string
}

/**
 * Convert PresenceShow to PresenceStatus for color mapping
 */
function getPresenceStatusFromShow(show: PresenceShow | undefined): PresenceStatus {
  if (!show) return 'online'
  switch (show) {
    case 'chat': return 'online'
    case 'away': return 'away'
    case 'xa': return 'away'
    case 'dnd': return 'dnd'
    default: return 'online'
  }
}

/**
 * Parse a hex color string to RGB values.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null
}

/**
 * Calculate relative luminance of a color (0-1 scale).
 * Used for contrast calculations per WCAG.
 */
function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map(c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}

/**
 * Darken a color by a given factor (0-1).
 */
function darkenColor(r: number, g: number, b: number, factor: number): string {
  const darken = (c: number) => Math.round(c * (1 - factor))
  return `#${darken(r).toString(16).padStart(2, '0')}${darken(g).toString(16).padStart(2, '0')}${darken(b).toString(16).padStart(2, '0')}`
}

/**
 * Ensure a color has enough contrast with white text.
 * If the color is too light, darken it until it has sufficient contrast.
 * This is applied at the end of color generation for avatar backgrounds.
 */
function ensureContrastWithWhite(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex

  const luminance = getLuminance(rgb.r, rgb.g, rgb.b)
  // White has luminance of 1.0
  // WCAG AA requires contrast ratio of 4.5:1 for normal text
  // Contrast ratio = (L1 + 0.05) / (L2 + 0.05)
  // For white (L=1) over background: (1 + 0.05) / (L + 0.05) >= 4.5
  // Solving: L <= (1.05 / 4.5) - 0.05 = 0.183
  const maxLuminance = 0.183

  if (luminance <= maxLuminance) {
    return hex // Already has enough contrast
  }

  // Darken the color progressively until it has enough contrast
  let { r, g, b } = rgb
  let factor = 0.1
  while (getLuminance(r, g, b) > maxLuminance && factor < 0.9) {
    r = Math.round(rgb.r * (1 - factor))
    g = Math.round(rgb.g * (1 - factor))
    b = Math.round(rgb.b * (1 - factor))
    factor += 0.1
  }

  return darkenColor(rgb.r, rgb.g, rgb.b, factor - 0.1)
}

/**
 * Reusable Avatar component with XEP-0392 consistent color generation.
 *
 * Features:
 * - Generates consistent colors from identifiers (same ID = same color)
 * - Falls back to first letter when no avatar image is available
 * - Supports presence indicators
 * - Multiple size presets
 * - Accessible with proper alt text
 */
export function Avatar({
  identifier,
  name,
  avatarUrl,
  size = 'sm',
  presence,
  presenceShow,
  className = '',
  onClick,
  clickable,
  presenceBorderColor = 'border-fluux-sidebar',
  overlay,
  fallbackColor,
}: AvatarProps) {
  // Generate consistent background color from identifier, or use custom fallbackColor
  // Own avatars also use consistent color (green is only used for own nickname text)
  const backgroundColor = useMemo(() => {
    if (fallbackColor) {
      // Ensure the fallback color has enough contrast with white text
      // by darkening it if too light (applied at the end of color generation)
      return ensureContrastWithWhite(fallbackColor)
    }
    return generateConsistentColorHexSync(identifier, { saturation: 60, lightness: 45 })
  }, [identifier, fallbackColor])

  // Get the display name and first letter
  const displayName = name || identifier
  const letter = displayName[0]?.toUpperCase() || '?'

  // Get size classes
  const sizeClasses = SIZES[size]

  // Determine presence color
  const effectivePresence = presenceShow ? getPresenceStatusFromShow(presenceShow) : presence
  const presenceColor = effectivePresence ? PRESENCE_COLORS[effectivePresence] : undefined

  // Determine if clickable
  const isClickable = clickable ?? !!onClick

  // Container classes
  const containerClasses = [
    sizeClasses.container,
    'rounded-full relative flex-shrink-0',
    isClickable ? 'cursor-pointer' : 'cursor-default',
    className,
  ].filter(Boolean).join(' ')

  return (
    <div className={containerClasses} onClick={onClick}>
      {avatarUrl ? (
        // Avatar image
        <img
          src={avatarUrl}
          alt={displayName}
          className="w-full h-full rounded-full object-cover"
          draggable={false}
        />
      ) : (
        // Letter fallback with consistent color
        <div
          className="w-full h-full rounded-full flex items-center justify-center"
          style={{ backgroundColor }}
        >
          <span className={`${sizeClasses.text} font-semibold text-white select-none`}>
            {letter}
          </span>
        </div>
      )}

      {/* Custom overlay or presence indicator */}
      {overlay ? (
        overlay
      ) : presenceColor && (
        <div
          className={`absolute ${sizeClasses.presence} rounded-full border-2 ${presenceBorderColor} ${presenceColor}`}
        />
      )}
    </div>
  )
}

/**
 * Hook to get avatar props for a contact
 */
export function useContactAvatarProps(contact: {
  jid: string
  name?: string
  avatar?: string
  presence?: PresenceStatus
}): Partial<AvatarProps> {
  return {
    identifier: contact.jid,
    name: contact.name || contact.jid,
    avatarUrl: contact.avatar,
    presence: contact.presence,
  }
}

/**
 * Typing indicator overlay component for use with Avatar
 */
export function TypingIndicator() {
  return (
    <div className="absolute -bottom-0.5 -right-0.5 w-5 h-3.5 bg-fluux-bg rounded-full border-2 border-fluux-sidebar flex items-center justify-center gap-0.5">
      <span className="w-1 h-1 bg-fluux-muted rounded-full animate-typing-dot-1" />
      <span className="w-1 h-1 bg-fluux-muted rounded-full animate-typing-dot-2" />
      <span className="w-1 h-1 bg-fluux-muted rounded-full animate-typing-dot-3" />
    </div>
  )
}

/**
 * Generate consistent text color for a nickname (for use in room messages)
 * Returns a CSS color string suitable for the `style.color` property.
 */
export function getConsistentTextColor(identifier: string, isDarkMode = true): string {
  return generateConsistentColorHexSync(identifier, {
    saturation: 70,
    lightness: isDarkMode ? 65 : 30,
  })
}

