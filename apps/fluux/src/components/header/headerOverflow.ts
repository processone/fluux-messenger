import type { LucideIcon } from 'lucide-react'

/** A single selectable action or option (a kebab/sheet row, or a dropdown item). */
export interface HeaderActionItem {
  key: string
  label: string
  /** Optional secondary line (e.g. the notification mode subtitle). */
  description?: string
  icon: LucideIcon
  /** Renders a check / active styling (e.g. the current notification mode). */
  active?: boolean
  /** Destructive (red) styling. */
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/** A titled set of items — a nested menu (notifications, room management). */
export interface HeaderActionGroup {
  title: string
  items: HeaderActionItem[]
}

/**
 * Collapse priority for a header action.
 * - `pinned`  — always inline, never collapses (members toggle).
 * - `search`  — collapses second (revealed inline on a medium-width header).
 * - `wide`    — collapses first (revealed inline only on a wide header).
 */
export type OverflowTier = 'pinned' | 'search' | 'wide'

/**
 * Container-query class pairs. The container is the `<header>` (marked
 * `@container`). `inline` is applied to the inline copy of an action; `kebab` to
 * its copy inside the overflow surface. Exactly one copy is visible at any width.
 *
 * NOTE: every string here is a literal so Tailwind's JIT content scanner emits
 * the arbitrary `@[…]` container variants. Never build these by
 * concatenating a tier prefix at runtime.
 *
 * Syntax note: `@tailwindcss/container-queries` (v0.1.x) spells an arbitrary
 * one-off container width as `@[440px]:` (→ `@container (min-width: 440px)`).
 * The `@min-[440px]:` form is a different (Tailwind v4) spelling that this
 * plugin does NOT emit — using it silently produces no CSS, so the collapse
 * never fires. Keep these as `@[…]`.
 */
// The `inline` copy is a header button laid out in the header's flex row, so its
// visible state is `flex`. The `kebab` copy is a stacked dropdown row (a submenu
// entry holds a section title above several item rows), so its visible state must
// be `block` — using `flex` there would lay the title and items out horizontally.
export const OVERFLOW_TIER: Record<OverflowTier, { inline: string; kebab: string }> = {
  pinned: { inline: 'flex', kebab: 'hidden' },
  search: { inline: 'hidden @[440px]:flex', kebab: 'block @[440px]:hidden' },
  wide: { inline: 'hidden @[600px]:flex', kebab: 'block @[600px]:hidden' },
}

/** Hide the kebab trigger once the widest collapsible tier is shown inline. */
export const KEBAB_TRIGGER_CLASS = 'flex @[600px]:hidden'

export function inlineClass(tier: OverflowTier): string {
  return OVERFLOW_TIER[tier].inline
}

export function kebabClass(tier: OverflowTier): string {
  return OVERFLOW_TIER[tier].kebab
}
