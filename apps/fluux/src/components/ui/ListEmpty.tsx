import type { LucideIcon } from 'lucide-react'

interface ListEmptyProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: { label: string; icon?: LucideIcon; onClick: () => void }
  className?: string
}

/**
 * Shared empty-state for in-list / in-panel surfaces (conversation list, contacts,
 * search results, admin lists). Restrained composition: a muted icon, a one-line
 * title, an optional sub-line, and an optional accent action. The full-pane hero
 * empty state (no conversation/room selected) is the separate EmptyState in
 * ChatLayout; this is its compact sibling.
 */
export function ListEmpty({ icon: Icon, title, description, action, className = '' }: ListEmptyProps) {
  const ActionIcon = action?.icon
  return (
    <div className={`flex flex-col items-center justify-center text-center text-fluux-muted px-4 py-8 ${className}`}>
      {Icon && <Icon className="size-10 mb-3 opacity-60" />}
      <p className="text-sm">{title}</p>
      {description && <p className="text-xs opacity-75 mt-1 max-w-xs">{description}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 text-xs text-fluux-brand bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-lg transition-colors"
        >
          {ActionIcon && <ActionIcon className="size-3" />}
          {action.label}
        </button>
      )}
    </div>
  )
}
