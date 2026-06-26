import { useEffect, useRef, useState } from 'react'
import { MoreVertical, type LucideIcon } from 'lucide-react'
import { useClickOutside } from '@/hooks/useClickOutside'

export interface OverflowMenuItem {
  /** Stable key for the list. */
  key: string
  /** Visible label. */
  label: string
  icon: LucideIcon
  /** Invoked when the item is selected. The menu closes automatically. */
  onClick: () => void
  /** Renders the item in the destructive (red) style. */
  danger?: boolean
  /** Disables the item (no click, dimmed). */
  disabled?: boolean
}

interface OverflowMenuProps {
  /** Accessible label for the kebab trigger button. */
  ariaLabel: string
  /** Menu items. When empty the component renders nothing. */
  items: OverflowMenuItem[]
  /** Override the trigger button classes (defaults to the kebab touch-target style). */
  buttonClassName?: string
  /** Override the MoreVertical icon classes. */
  iconClassName?: string
  /** Override the dropdown container classes. */
  menuClassName?: string
}

const DEFAULT_BUTTON_CLASS =
  'p-2 rounded-lg text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center'
const DEFAULT_MENU_CLASS =
  'absolute end-0 mt-1 z-50 w-56 bg-fluux-sidebar border border-fluux-hover rounded-lg shadow-lg py-1'

/**
 * Generic kebab (overflow) menu: a `MoreVertical` trigger that opens a
 * dropdown of actions. Handles open state, click-outside and Escape to close,
 * and `role="menu"`/`role="menuitem"` semantics. Selecting an item closes the
 * menu and fires its `onClick`.
 */
export function OverflowMenu({
  ariaLabel,
  items,
  buttonClassName = DEFAULT_BUTTON_CLASS,
  iconClassName = 'size-5',
  menuClassName = DEFAULT_MENU_CLASS,
}: OverflowMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useClickOutside(menuRef, () => setIsOpen(false), isOpen)

  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen])

  if (items.length === 0) return null

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className={buttonClassName}
      >
        <MoreVertical className={iconClassName} />
      </button>

      {isOpen && (
        <div role="menu" className={menuClassName}>
          {items.map(({ key, label, icon: Icon, onClick, danger, disabled }) => (
            <button
              key={key}
              role="menuitem"
              type="button"
              disabled={disabled}
              onClick={() => {
                setIsOpen(false)
                onClick()
              }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-start text-sm transition-colors hover:bg-fluux-active disabled:opacity-50 disabled:cursor-not-allowed ${danger ? 'text-fluux-error' : 'text-fluux-text'}`}
            >
              <Icon className="size-4 flex-shrink-0" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
