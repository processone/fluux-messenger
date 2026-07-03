import React from 'react'
import { useLocation } from 'react-router-dom'
import { Tooltip } from '../Tooltip'
import type { SidebarView } from './types'

interface IconRailNavLinkProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  /** The view this button navigates to */
  view: SidebarView
  /** Path prefix to match for active state (e.g., '/messages', '/rooms') */
  pathPrefix: string
  showBadge?: boolean
  /** Dot colour when showBadge is true. 'strong' (red) is the attention tier (DMs,
   *  mentions, contact requests); 'neutral' (grey) is ambient unread. Defaults to 'strong'. */
  tone?: 'neutral' | 'strong'
  /** Overrides the button aria-label (the tooltip still shows `label`). */
  badgeLabel?: string
  /** Handler called when clicked - should handle navigation */
  onNavigate: (view: SidebarView) => void
}

/**
 * Icon rail button that derives active state from URL but uses onClick for navigation.
 * This ensures all navigation goes through a single code path that can handle
 * state cleanup (clearing admin state, selected contact, etc.).
 */
export function IconRailNavLink({
  icon: Icon,
  label,
  view,
  pathPrefix,
  showBadge,
  tone = 'strong',
  badgeLabel,
  onNavigate,
}: IconRailNavLinkProps) {
  const location = useLocation()
  const isActive = location.pathname === pathPrefix || location.pathname.startsWith(pathPrefix + '/')
  // The badge is "cut out" from the button surface with a ring the same colour
  // as that surface — accent when the tab is selected, the rail otherwise.
  const ringClass = isActive ? 'ring-fluux-brand' : 'ring-fluux-sidebar'
  // Both tones read fine on the accent surface of a selected tab, so the dot
  // keeps its colour regardless of selection — a red badge that stays red when
  // selected is more consistent than flipping it to white.
  const dotFillClass = tone === 'neutral' ? 'bg-fluux-gray' : 'bg-fluux-badge-strong'

  return (
    <Tooltip content={label} position="right" delay={500}>
      <button
        onClick={() => onNavigate(view)}
        aria-label={badgeLabel ?? label}
        data-nav={view}
        className={`
          icon-rail-btn relative rounded-xl flex items-center justify-center transition-colors
          focus-visible:ring-2 focus-visible:ring-fluux-brand focus-visible:ring-offset-2 focus-visible:ring-offset-fluux-sidebar
          ${isActive
            ? 'bg-fluux-brand text-fluux-text-on-accent'
            : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text'
          }
        `}
      >
        <Icon className="size-5" />
        {showBadge ? (
          <span className={`absolute top-0.5 end-0.5 size-2.5 ${dotFillClass} rounded-full ring-2 ${ringClass}`} />
        ) : null}
      </button>
    </Tooltip>
  )
}
