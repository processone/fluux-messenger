import { useId } from 'react'
import { starField } from './auroraSeed'

/**
 * Aurora brand mark (login screen): a hand-drawn speech-bubble silhouette
 * rendered as a liquid-glass pane, backlit by the aurora (G2 finish).
 * Spec: docs/superpowers/specs/2026-07-06-aurora-login-mark-design.md §3.
 *
 * Layer stack (bottom → top): backlight blobs → pane (fill + lensing copies +
 * stars + sheen + grain) → aurora rim (glow + crisp) → specular hairline.
 * Colors come from the --fluux-aurora-* tokens, so the night/dawn split and
 * any theme overrides apply without touching this file. Mode-specific layers
 * (stars, night fill vs paper wash, white vs ink hairline, drop shadow) are
 * all rendered and toggled via CSS under `.light` — the component itself is
 * mode-agnostic. Motion is pure CSS (see "Aurora brand mark" in index.css).
 */

const BUBBLE =
  'M 100 18 C 145 18 178 45 178 82 C 178 119 145 145 100 145 ' +
  'C 89 145 78.5 143 69.5 139.5 C 58 149 44 154.5 30 155 ' +
  'C 38.5 145.5 43.5 135.5 44.8 126.5 C 32 116 24 100 24 82 ' +
  'C 24 45 55 18 100 18 Z'
const TX = 'translate(32,30)'

/** Backlight blob geometry (viewBox space) — stop 1 low-left, 3 mid, 4 upper-right. */
const BLOBS = [
  { cx: 95, cy: 165, rx: 55, ry: 42, token: 1, opacity: 0.42 },
  { cx: 150, cy: 115, rx: 50, ry: 42, token: 3, opacity: 0.38 },
  { cx: 185, cy: 65, rx: 48, ry: 40, token: 4, opacity: 0.4 },
] as const

const STARS = starField(31, 8, { x: 56, y: 44, w: 150, h: 110 })

const RIM_STOPS = [
  { offset: 0, token: 1 },
  { offset: 0.45, token: 2 },
  { offset: 0.72, token: 3 },
  { offset: 1, token: 4 },
] as const

interface AuroraMarkProps {
  /** Rendered width in px (viewBox is 264×240; height scales proportionally). */
  size?: number
  className?: string
}

export function AuroraMark({ size = 150, className }: AuroraMarkProps) {
  const uid = useId().replace(/:/g, '')
  const id = (s: string) => `am-${uid}-${s}`
  const height = Math.round((size * 240) / 264)

  return (
    <svg
      className={`aurora-mark ${className ?? ''}`}
      width={size}
      height={height}
      viewBox="0 0 264 240"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id('rim')} gradientUnits="userSpaceOnUse" x1="76" y1="185" x2="210" y2="48">
          {RIM_STOPS.map((s) => (
            <stop key={s.offset} offset={s.offset} style={{ stopColor: `var(--fluux-aurora-rim-${s.token})` }} />
          ))}
        </linearGradient>
        <linearGradient id={id('sheen')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.1" />
          <stop offset="0.4" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={id('spec')} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.55" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.05" />
        </linearGradient>
        <linearGradient id={id('pane-light')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.72" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.42" />
        </linearGradient>
        <clipPath id={id('clip')}>
          <path d={BUBBLE} transform={TX} />
        </clipPath>
        <filter id={id('blur-big')} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="16" />
        </filter>
        <filter id={id('blur-lens')} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="11" />
        </filter>
        <filter id={id('blur-glow')} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <filter id={id('blur-shadow')} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <filter id={id('grain')}>
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>

      {/* light-mode drop shadow — depth comes from shadow, not glow, on pale bg */}
      <ellipse
        className="aurora-mark-shadow aurora-light-only"
        cx="132" cy="196" rx="78" ry="14"
        fill="#2A3554" opacity="0.14" filter={`url(#${id('blur-shadow')})`}
      />

      <g className="aurora-mark-backlight">
        {BLOBS.map((b, i) => (
          <ellipse
            key={b.token}
            className={`aurora-breathe-${i + 1}`}
            cx={b.cx} cy={b.cy} rx={b.rx} ry={b.ry}
            style={{ fill: `var(--fluux-aurora-${b.token})` }}
            opacity={b.opacity}
            filter={`url(#${id('blur-big')})`}
          />
        ))}
      </g>

      <g clipPath={`url(#${id('clip')})`}>
        <rect className="aurora-mark-pane aurora-dark-only" x="40" y="30" width="200" height="185" fill="#0A1124" opacity="0.42" />
        <path className="aurora-mark-pane aurora-light-only" d={BUBBLE} transform={TX} fill={`url(#${id('pane-light')})`} />
        <g className="aurora-mark-lens">
          {BLOBS.map((b) => (
            <ellipse
              key={b.token}
              cx={b.cx + 7} cy={b.cy + 4} rx={b.rx} ry={b.ry}
              style={{ fill: `var(--fluux-aurora-${b.token})` }}
              opacity={b.opacity * 0.9}
              filter={`url(#${id('blur-lens')})`}
            />
          ))}
        </g>
        <g className="aurora-mark-stars aurora-dark-only">
          {STARS.map((s, i) => (
            <circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill="#C7D2FE" opacity={s.opacity} />
          ))}
        </g>
        <path d={BUBBLE} transform={TX} fill={`url(#${id('sheen')})`} />
        <rect
          x="40" y="30" width="200" height="185"
          filter={`url(#${id('grain')})`} opacity="0.1"
          style={{ mixBlendMode: 'soft-light' }}
        />
      </g>

      <path
        className="aurora-mark-rim-glow"
        d={BUBBLE} transform={TX} fill="none"
        stroke={`url(#${id('rim')})`} strokeWidth="8" strokeLinejoin="round"
        filter={`url(#${id('blur-glow')})`}
      />
      <path
        className="aurora-mark-rim"
        d={BUBBLE} transform={TX} fill="none"
        stroke={`url(#${id('rim')})`} strokeWidth="2.4" strokeLinejoin="round" opacity="0.95"
      />
      <path
        className="aurora-mark-hairline-dark aurora-dark-only"
        d={BUBBLE} transform={TX} fill="none"
        stroke={`url(#${id('spec')})`} strokeWidth="1" strokeLinejoin="round" opacity="0.5"
      />
      <path
        className="aurora-mark-hairline-light aurora-light-only"
        d={BUBBLE} transform={TX} fill="none"
        stroke="rgba(30,42,70,0.30)" strokeWidth="0.8" strokeLinejoin="round"
      />
    </svg>
  )
}
