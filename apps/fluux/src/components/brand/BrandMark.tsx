import { AppIconMark } from './AppIconMark'
import { HollowIconMark } from './HollowIconMark'

interface BrandMarkProps {
  /** Icon edge in CSS pixels. */
  size?: number
  className?: string
}

/**
 * The app icon itself (aurora tile + white bubble), so the mark matches the installed app icon on
 * the dock or home screen, with a soft aurora halo behind it for a little lift. It opens the login
 * screen and the first-run welcome.
 */
export function BrandMark({ size = 72, className = '' }: BrandMarkProps) {
  // The neutral drop shadow keeps the icon defined on pale backgrounds: the halo glows on dark
  // surfaces but does not draw an edge on light ones.
  const iconClass = 'relative [filter:drop-shadow(0_6px_16px_rgba(26,32,64,0.22))]'
  return (
    <div className={`relative mx-auto ${className}`} style={{ width: size }}>
      <div
        className="absolute -inset-2.5 rounded-[26px] blur-2xl opacity-45 pointer-events-none"
        style={{ background: 'var(--fluux-grad)' }}
        aria-hidden="true"
      />
      {import.meta.env.VITE_FLUUX_ICON_STYLE === 'plain'
        ? <AppIconMark size={size} className={iconClass} />
        : <HollowIconMark size={size} className={iconClass} />}
    </div>
  )
}
