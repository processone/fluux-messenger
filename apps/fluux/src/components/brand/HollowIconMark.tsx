import { useId } from 'react'
import {
  MESSAGE_BUBBLE_PATH,
  GLYPH_TRANSFORM,
  GLYPH_STROKE_WIDTH,
  GLYPH_SHADOW,
} from './messageBubbleGlyph'

/**
 * Hollow variant of the Fluux app icon for the login screen: the same aurora
 * gradient squircle as AppIconMark, but with the chat bubble drawn as a white
 * outline (drop shadow only, no glass fill). Mirrors
 * src-tauri/icons/icon-variants/hollow/icon-source.svg so the login mark and the
 * installed hollow app icon are the same object. Decorative (aria-hidden).
 */

const TILE = { x: 61, y: 61, w: 902, h: 902, rx: 225 }

interface HollowIconMarkProps {
  /** Rendered square size in px (viewBox is 1024×1024). */
  size?: number
  className?: string
}

export function HollowIconMark({ size = 72, className }: HollowIconMarkProps) {
  const uid = useId().replace(/:/g, '')
  const id = (s: string) => `hi-${uid}-${s}`

  return (
    <svg
      className={`hollow-icon-mark ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id('aurora')} x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#38E0C4" />
          <stop offset="0.52" stopColor="#7C8CFF" />
          <stop offset="1" stopColor="#A78BFA" />
        </linearGradient>
        <radialGradient id={id('bloomTeal')} cx="0.16" cy="0.9" r="0.57">
          <stop offset="0" stopColor="#3FF0D6" stopOpacity="0.25" />
          <stop offset="1" stopColor="#3FF0D6" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('bloomViolet')} cx="0.9" cy="0.1" r="0.57">
          <stop offset="0" stopColor="#B79CFF" stopOpacity="0.22" />
          <stop offset="1" stopColor="#B79CFF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('sheen')} x1="512" y1="61" x2="512" y2="963" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.22" />
          <stop offset="0.19" stopColor="#FFFFFF" stopOpacity="0.04" />
          <stop offset="0.34" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <clipPath id={id('tile')}>
          <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} rx={TILE.rx} />
        </clipPath>
        <filter id={id('glyphShadow')} x="-30%" y="-30%" width="160%" height="180%">
          <feDropShadow
            dx="0"
            dy={GLYPH_SHADOW.dy}
            stdDeviation={GLYPH_SHADOW.stdDeviation}
            floodColor={GLYPH_SHADOW.color}
            floodOpacity={GLYPH_SHADOW.opacity}
          />
        </filter>
      </defs>

      <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} rx={TILE.rx} fill={`url(#${id('aurora')})`} />
      <g clipPath={`url(#${id('tile')})`}>
        <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} fill={`url(#${id('bloomTeal')})`} />
        <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} fill={`url(#${id('bloomViolet')})`} />
        <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} fill={`url(#${id('sheen')})`} />
      </g>
      <rect x="63.5" y="63.5" width="897" height="897" rx="222.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.15" strokeWidth="3" />

      {/* Shadow on the unscaled wrapper (absolute 1024-space); transform on the
          inner group. See messageBubbleGlyph.ts GLYPH_SHADOW note. */}
      <g filter={`url(#${id('glyphShadow')})`}>
        <g transform={GLYPH_TRANSFORM}>
          <path
            d={MESSAGE_BUBBLE_PATH}
            fill="none"
            stroke="#FFFFFF"
            strokeWidth={GLYPH_STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </g>
    </svg>
  )
}
