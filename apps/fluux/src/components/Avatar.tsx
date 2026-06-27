import { useState, useEffect, useRef, type ReactNode } from 'react'
import { generateConsistentColorHexSync, type PresenceStatus, type PresenceShow } from '@fluux/sdk'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS } from '@/constants/ui'
import { ensureContrastWithWhite } from '@/utils/contrastColor'

/**
 * Avatar sizes and their corresponding Tailwind classes
 */
const SIZES = {
  xs: { container: 'size-6', text: 'text-xs', presence: 'size-2 -bottom-0 -end-0' },
  sm: { container: 'size-8', text: 'text-sm', presence: 'size-3 -bottom-0.5 -end-0.5' },
  header: { container: 'size-9', text: 'text-base', presence: 'size-3 -bottom-0.5 -end-0.5' },
  md: { container: 'size-10', text: 'text-base', presence: 'size-3.5 -bottom-0.5 -end-0.5' },
  lg: { container: 'size-12', text: 'text-lg', presence: 'size-4 -bottom-0.5 -end-0.5' },
  xl: { container: 'size-24', text: 'text-3xl', presence: 'size-5 bottom-0 end-0' },
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

  /**
   * When true, forces the presence indicator to show the offline color
   * regardless of actual presence. Parent components should pass this
   * based on connection status to avoid per-Avatar store subscriptions.
   */
  forceOffline?: boolean

  /**
   * Avatar shape. People are circular; rooms/groups are rounded squares.
   * @default 'circle'
   */
  shape?: 'circle' | 'square'
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
 * Module-level cache of extracted first frames, keyed by avatar URL. It outlives
 * any single Avatar mount so a frozen frame is reused instantly when the same URL
 * mounts again — e.g. a virtualized message row scrolling back into view. Without
 * it, each remount restarts the async extraction and the GIF replays its opening
 * frames every time it re-enters the viewport. Bounded so churning blob: URLs
 * (re-minted on every reconnect) can't grow it without limit.
 */
const STATIC_FRAME_CACHE_CAP = 256
const staticFrameCache = new Map<string, string>()

function cacheStaticFrame(url: string, dataUrl: string): void {
  if (staticFrameCache.size >= STATIC_FRAME_CACHE_CAP) {
    const oldest = staticFrameCache.keys().next().value
    if (oldest !== undefined) staticFrameCache.delete(oldest)
  }
  staticFrameCache.set(url, dataUrl)
}

/**
 * For animated GIF avatars, extract the first frame as a static PNG data URL.
 * Returns null for non-GIF images or while loading. A cached frame for the same
 * URL is applied synchronously on mount (no re-fetch, no replay).
 */
function useStaticFrame(url: string | undefined): string | null {
  const [frame, setFrame] = useState<string | null>(() =>
    url ? staticFrameCache.get(url) ?? null : null
  )

  useEffect(() => {
    if (!url) { setFrame(null); return }
    const cached = staticFrameCache.get(url)
    if (cached) { setFrame(cached); return }
    setFrame(null)
    let cancelled = false

    fetch(url)
      .then(r => r.blob())
      .then(blob => {
        if (cancelled || blob.type !== 'image/gif') return
        const img = new Image()
        img.onload = () => {
          if (cancelled) return
          const c = document.createElement('canvas')
          c.width = img.naturalWidth
          c.height = img.naturalHeight
          c.getContext('2d')?.drawImage(img, 0, 0)
          const dataUrl = c.toDataURL('image/png')
          cacheStaticFrame(url, dataUrl)
          setFrame(dataUrl)
        }
        img.src = url
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [url])

  return frame
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
 * - Animated GIF avatars are frozen by default, play on hover
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
  forceOffline = false,
  shape = 'circle',
}: AvatarProps) {
  // Generate consistent background color from identifier, or use custom fallbackColor
  const backgroundColor = fallbackColor
    || ensureContrastWithWhite(generateConsistentColorHexSync(identifier, { saturation: 60, lightness: 45 }))

  // Get the display name and first letter
  const displayName = name || identifier
  const letter = displayName[0]?.toUpperCase() || '?'

  // Get size classes
  const sizeClasses = SIZES[size]

  const radiusClass = shape === 'square' ? 'rounded-xl' : 'rounded-full'

  // Determine presence color
  // Uses CSS custom properties for smooth color transitions between states
  const isOffline = forceOffline
  const resolvedPresence = presenceShow ? getPresenceStatusFromShow(presenceShow) : presence
  const presenceColor = resolvedPresence
    ? (isOffline ? APP_OFFLINE_PRESENCE_COLOR : PRESENCE_COLORS[resolvedPresence])
    : undefined

  // Map presence to CSS variable for smooth transition
  const PRESENCE_CSS_VARS: Record<PresenceStatus, string> = {
    online: 'var(--fluux-presence-online)',
    away: 'var(--fluux-presence-away)',
    dnd: 'var(--fluux-presence-dnd)',
    offline: 'var(--fluux-presence-offline)',
  }
  // When offline (app reconnecting), let the className path apply the grey
  // APP_OFFLINE_PRESENCE_COLOR instead of an inline color. A truthy style object
  // with backgroundColor: undefined would suppress that class and leave the pill
  // transparent (border-only).
  const presenceBgStyle = resolvedPresence && !isOffline
    ? { backgroundColor: PRESENCE_CSS_VARS[resolvedPresence] }
    : undefined

  // Track image load errors to fall back to letter display.
  const [imgError, setImgError] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  // WebKit (Tauri webview) does not reliably fire `<img>` onError for a revoked
  // `blob:` URL whose backing store it reclaimed across an OS sleep — the image
  // silently fails to decode and the row shows a broken-image glyph instead of
  // the letter fallback. Don't depend on the error event: after the load
  // settles, a failed image is `complete` with `naturalWidth === 0`. Reset on
  // URL change, check immediately if already settled, and re-check shortly after
  // for the no-event case.
  useEffect(() => {
    setImgError(false)
    if (!avatarUrl) return
    const checkBroken = () => {
      const img = imgRef.current
      if (img && img.complete && img.naturalWidth === 0) setImgError(true)
    }
    checkBroken()
    const timer = setTimeout(checkBroken, 1500)
    return () => clearTimeout(timer)
  }, [avatarUrl])

  // Animated GIF: show static first frame by default, animate on hover
  const staticFrame = useStaticFrame(avatarUrl)
  const [hovered, setHovered] = useState(false)

  // Determine if clickable
  const isClickable = clickable ?? !!onClick

  // Container classes
  const containerClasses = [
    sizeClasses.container,
    `${radiusClass} relative flex-shrink-0`,
    isClickable ? 'cursor-pointer' : 'cursor-default',
    className,
  ].filter(Boolean).join(' ')

  return (
    <div
      className={containerClasses}
      {...(isClickable
        ? {
            role: 'button' as const,
            tabIndex: 0,
            onClick,
            onKeyDown: (e: import('react').KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            },
          }
        : {})}
      onMouseEnter={staticFrame ? () => setHovered(true) : undefined}
      onMouseLeave={staticFrame ? () => setHovered(false) : undefined}
    >
      {avatarUrl && !imgError ? (
        <img
          ref={imgRef}
          src={staticFrame && !hovered ? staticFrame : avatarUrl}
          alt={displayName}
          className={`w-full h-full ${radiusClass} object-cover`}
          draggable={false}
          onError={() => setImgError(true)}
          onLoad={(e) => { if (e.currentTarget.naturalWidth === 0) setImgError(true) }}
        />
      ) : (
        // Letter fallback with consistent color
        <div
          className={`w-full h-full ${radiusClass} flex items-center justify-center`}
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
          className={`absolute ${sizeClasses.presence} rounded-full border-2 ${presenceBorderColor} ${presenceBgStyle ? '' : presenceColor} transition-colors duration-500 ease-in-out`}
          style={presenceBgStyle}
        />
      )}
    </div>
  )
}

/**
 * Typing indicator overlay component for use with Avatar
 */
export function TypingIndicator() {
  return (
    <div className="absolute -bottom-0.5 -end-0.5 w-5 h-3.5 bg-fluux-bg rounded-full border-2 border-fluux-sidebar flex items-center justify-center gap-0.5">
      <span className="size-1 bg-fluux-muted rounded-full animate-typing-dot-1" />
      <span className="size-1 bg-fluux-muted rounded-full animate-typing-dot-2" />
      <span className="size-1 bg-fluux-muted rounded-full animate-typing-dot-3" />
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
