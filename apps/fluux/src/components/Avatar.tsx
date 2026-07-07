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

  /** Colour for the fallback letter. Defaults to white. Set to a best-contrast
   *  value (see bestTextColor) when fallbackColor is a light fill. */
  fallbackTextColor?: string

  /** Adds a soft colored glow behind the presence dot (Aurora members panel). */
  presenceHalo?: boolean

  /**
   * Glyph rendered on the colored background when no avatar image is present,
   * in place of the first letter. Used for non-person entities such as rooms
   * (e.g. a Hash icon). Ignored when an avatar image is shown.
   */
  fallbackIcon?: ReactNode

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
 * In-flight first-frame extractions, keyed by avatar URL. Dedupes concurrent
 * decodes of the same avatar (it can be mounted in several visible rows at once)
 * and, crucially, lets an extraction outlive the component that started it. A
 * virtualized row routinely unmounts mid-decode while the user scrolls past;
 * tying the decode to that component's lifetime meant the frozen frame never
 * reached the cache during scrolling, so every scroll-in replayed the GIF.
 */
const inFlightFrames = new Map<string, Promise<string | null>>()

// Control-chunk markers that only appear in animated files: 'acTL' (APNG) and
// 'ANIM' (animated WebP).
const APNG_ACTL = [0x61, 0x63, 0x54, 0x4c]
const WEBP_ANIM = [0x41, 0x4e, 0x49, 0x4d]

function containsMarker(bytes: Uint8Array, marker: number[], limit: number): boolean {
  const end = Math.min(bytes.length - marker.length, limit)
  for (let i = 0; i <= end; i++) {
    let hit = true
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) { hit = false; break }
    }
    if (hit) return true
  }
  return false
}

/**
 * Detect an animated raster image from its bytes, independent of the declared
 * MIME type. The type cannot be trusted: the SDK occupant-avatar path stores
 * avatars as image/png regardless of the real format (Profile.ts), and many
 * animated avatars are APNG or animated WebP rather than GIF. Covers exactly the
 * formats WebKit animates in an <img>. The marker scan is capped to the header
 * region where the control chunks always sit.
 */
function isAnimatedImage(buffer: ArrayBuffer): boolean {
  const b = new Uint8Array(buffer)
  if (b.length < 12) return false
  // GIF87a / GIF89a — a single-frame GIF frozen is identical, so freeze all GIFs.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true
  // APNG: PNG signature followed by an 'acTL' chunk (absent in static PNGs).
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return containsMarker(b, APNG_ACTL, 4096)
  }
  // Animated WebP: RIFF....WEBP container with an 'ANIM' chunk.
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return containsMarker(b, WEBP_ANIM, 4096)
  }
  return false
}

/**
 * Extract an animated avatar's first frame as a static PNG data URL and populate
 * the module-level cache on success. Resolves to null for static images or on any
 * decode failure. Animation is decided from the image bytes (GIF / APNG /
 * animated WebP), never the declared MIME type. Deliberately decoupled from
 * React: it is NOT cancelled when the requesting component unmounts, so the cache
 * fills even during fast scrolling.
 */
function extractFirstFrame(url: string): Promise<string | null> {
  const cached = staticFrameCache.get(url)
  if (cached) return Promise.resolve(cached)
  const pending = inFlightFrames.get(url)
  if (pending) return pending

  const extraction = fetch(url)
    .then(r => r.arrayBuffer())
    .then(buffer => {
      if (!isAnimatedImage(buffer)) return null
      return new Promise<string | null>((resolve) => {
        const img = new Image()
        img.onload = () => {
          const c = document.createElement('canvas')
          c.width = img.naturalWidth
          c.height = img.naturalHeight
          const ctx = c.getContext('2d')
          if (!ctx) { resolve(null); return }
          ctx.drawImage(img, 0, 0)
          const dataUrl = c.toDataURL('image/png')
          cacheStaticFrame(url, dataUrl)
          resolve(dataUrl)
        }
        img.onerror = () => resolve(null)
        img.src = url
      })
    })
    .catch(() => null)
    .finally(() => { inFlightFrames.delete(url) })

  inFlightFrames.set(url, extraction)
  return extraction
}

/**
 * For animated avatars (GIF, APNG, animated WebP), extract the first frame as a
 * static PNG data URL. Returns null for static images or while loading. A cached
 * frame for the same URL is applied synchronously on mount (no re-fetch, no
 * replay).
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
    // Extraction runs to completion regardless of unmount (it feeds the shared
    // cache for the next mount); only the state update is guarded so we never
    // setState on an unmounted row.
    void extractFirstFrame(url).then(dataUrl => {
      if (!cancelled && dataUrl) setFrame(dataUrl)
    })

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
 * - Animated avatars (GIF, APNG, animated WebP) are frozen by default, play on hover
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
  fallbackIcon,
  fallbackTextColor,
  presenceHalo = false,
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
        // Icon or letter fallback with consistent color
        <div
          className={`w-full h-full ${radiusClass} flex items-center justify-center`}
          style={{ backgroundColor }}
        >
          {fallbackIcon ? (
            <span className="text-white flex items-center justify-center">{fallbackIcon}</span>
          ) : (
            <span
              className={`${sizeClasses.text} font-semibold select-none`}
              style={{ color: fallbackTextColor ?? '#ffffff' }}
            >
              {letter}
            </span>
          )}
        </div>
      )}

      {/* Custom overlay or presence indicator */}
      {overlay ? (
        overlay
      ) : presenceColor && (
        <div
          className={`absolute ${sizeClasses.presence} rounded-full border-2 ${presenceBorderColor} ${presenceBgStyle ? '' : presenceColor} transition-colors duration-500 ease-in-out`}
          style={{
            ...presenceBgStyle,
            ...(presenceHalo && presenceBgStyle
              ? { boxShadow: `0 0 5px ${PRESENCE_CSS_VARS[resolvedPresence!]}` }
              : {}),
          }}
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
      {/* Aurora-shimmer dots, matching the room sidebar typing indicator (delays + colors in CSS). */}
      <span className="size-1 rounded-full typing-dot" />
      <span className="size-1 rounded-full typing-dot" />
      <span className="size-1 rounded-full typing-dot" />
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
