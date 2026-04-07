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
  onNavigate,
}: IconRailNavLinkProps) {
  const location = useLocation()
  const isActive = location.pathname === pathPrefix || location.pathname.startsWith(pathPrefix + '/')

  return (
    <Tooltip content={label} position="right" delay={500}>
      <button
        onClick={() => onNavigate(view)}
        aria-label={label}
        data-nav={view}
        className={`
          relative w-10 h-10 rounded-xl flex items-center justify-center transition-colors
          focus-visible:ring-2 focus-visible:ring-fluux-brand focus-visible:ring-offset-2 focus-visible:ring-offset-fluux-sidebar
          ${isActive
            ? 'bg-fluux-brand text-fluux-text-on-accent'
            : 'text-fluux-muted hover:bg-white/10 hover:text-fluux-text'
          }
        `}
      >
        <Icon className="w-5 h-5" />
        {showBadge && (
          <span className="absolute top-0 end-0 w-3 h-3 bg-fluux-red rounded-full border-2 border-fluux-sidebar" />
        )}
      </button>
    </Tooltip>
  )
}
