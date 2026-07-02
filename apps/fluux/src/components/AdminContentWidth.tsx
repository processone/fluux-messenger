import type { ReactNode } from 'react'

interface AdminContentWidthProps {
  children: ReactNode
  className?: string
}

/**
 * Shared width/centering treatment for admin drill-in screens (user list,
 * room list, user detail, room detail, command forms): capped at max-w-2xl
 * and centered, so every screen reads as one consistent column instead of
 * stretching edge-to-edge or sitting flush-left on wide panels.
 *
 * Card-grid screens (ServerOverview) intentionally don't use this — a grid
 * benefits from the full available width, unlike a list or a form.
 */
export function AdminContentWidth({ children, className = '' }: AdminContentWidthProps) {
  return <div className={`w-full max-w-2xl mx-auto ${className}`}>{children}</div>
}
