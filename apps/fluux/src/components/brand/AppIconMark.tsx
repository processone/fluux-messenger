import { useId } from 'react'

/**
 * The Fluux app icon, inlined as a component for the login screen: the aurora
 * gradient squircle with the white speech bubble. Mirrors the shipped
 * `src-tauri/icons/icon-source.svg` (the "in-between" glass pass) so the login
 * mark and the installed app icon are the same object. Decorative
 * (`aria-hidden`); mode-agnostic (the tile gradient is fixed in both themes).
 */

const TILE = { x: 61, y: 61, w: 902, h: 902, rx: 225 }

interface AppIconMarkProps {
  /** Rendered square size in px (viewBox is 1024×1024). */
  size?: number
  className?: string
}

export function AppIconMark({ size = 72, className }: AppIconMarkProps) {
  const uid = useId().replace(/:/g, '')
  const id = (s: string) => `ai-${uid}-${s}`

  return (
    <svg
      className={`app-icon-mark ${className ?? ''}`}
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
        <linearGradient id={id('bubble')} x1="262" y1="315" x2="262" y2="672" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#EAF0FF" />
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
        <filter id={id('depth')} x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="16" stdDeviation="22" floodColor="#1A1145" floodOpacity="0.25" />
        </filter>
        <clipPath id={id('tile')}>
          <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} rx={TILE.rx} />
        </clipPath>
      </defs>

      <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} rx={TILE.rx} fill={`url(#${id('aurora')})`} />
      <g clipPath={`url(#${id('tile')})`}>
        <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} fill={`url(#${id('bloomTeal')})`} />
        <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} fill={`url(#${id('bloomViolet')})`} />
        <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} fill={`url(#${id('sheen')})`} />
      </g>
      <rect x="63.5" y="63.5" width="897" height="897" rx="222.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.15" strokeWidth="3" />

      <g filter={`url(#${id('depth')})`} fill={`url(#${id('bubble')})`}>
        <rect x="262" y="315" width="500" height="357" rx="132" />
        <path d="M405 665 L332 808 L548 665 Z" />
      </g>
    </svg>
  )
}
