import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check, type LucideIcon } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import { useAnchoredMenu, useClickOutside } from '@/hooks'
import type { HeaderActionGroup } from './headerOverflow'

interface HeaderSubmenuButtonProps {
  ariaLabel: string
  tooltip: string
  icon: LucideIcon
  active?: boolean
  group: HeaderActionGroup
  /** Override trigger classes (the caller passes the active/idle styling). */
  className?: string
}

export function HeaderSubmenuButton({ ariaLabel, tooltip, icon: Icon, active, group, className }: HeaderSubmenuButtonProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const menu = useAnchoredMenu(open)

  useClickOutside(containerRef, () => setOpen(false), open)
  useEffect(() => {
    if (!open) return
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [open])

  const idle = 'hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text'
  const on = 'bg-fluux-brand/20 text-fluux-brand'

  return (
    <div className="relative" ref={containerRef}>
      <Tooltip content={tooltip} position="bottom" disabled={open}>
        <button
          ref={menu.triggerRef}
          onClick={() => setOpen((v) => !v)}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          className={className ?? `flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors tap-target ${active ? on : idle}`}
        >
          <Icon className="size-4" />
          <ChevronDown className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </Tooltip>

      {open && (
        <div
          ref={menu.menuRef}
          role="menu"
          style={{ left: menu.position.x, top: menu.position.y }}
          className="fixed w-64 max-w-[calc(100vw-1rem)] bg-fluux-bg border border-fluux-hover rounded-lg shadow-lg z-30 py-1"
        >
          {group.items.map((item) => {
            const ItemIcon = item.icon
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => { setOpen(false); item.onSelect() }}
                className={`w-full flex items-center gap-3 px-3 py-2 text-start transition-colors hover:bg-fluux-hover disabled:opacity-50 disabled:cursor-not-allowed ${item.danger ? 'text-fluux-error' : 'text-fluux-text'}`}
              >
                <ItemIcon className="size-4 flex-shrink-0 text-fluux-muted" />
                <span className="flex-1">
                  <span className="block text-sm">{item.label}</span>
                  {item.description && <span className="block text-xs text-fluux-muted">{item.description}</span>}
                </span>
                {item.active && <Check className="size-4 text-fluux-brand" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
