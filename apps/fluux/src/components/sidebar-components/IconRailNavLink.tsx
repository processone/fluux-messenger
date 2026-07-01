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
  /** When > 0, renders a red numeric badge (clamped to 99+). Takes precedence over showBadge. */
  badgeCount?: number
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
  badgeCount,
  badgeLabel,
  onNavigate,
}: IconRailNavLinkProps) {
  const location = useLocation()
  const isActive = location.pathname === pathPrefix || location.pathname.startsWith(pathPrefix + '/')
  const hasCount = typeof badgeCount === 'number' && badgeCount > 0

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
        {hasCount ? (
          <span className="absolute -top-0.5 -end-0.5 min-w-4 h-4 px-1 flex items-center justify-center bg-fluux-red text-white text-[10px] leading-none font-semibold rounded-full border-2 border-fluux-sidebar">
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        ) : showBadge ? (
          <span className="absolute top-0 end-0 size-3 bg-fluux-red rounded-full border-2 border-fluux-sidebar" />
        ) : null}
      </button>
    </Tooltip>
  )
}
