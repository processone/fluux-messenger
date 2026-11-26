import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreVertical, ChevronLeft, ChevronRight, Check, type LucideIcon } from 'lucide-react'
import { TouchMenu } from '../ui/TouchMenu'
import { useHasHover } from '@/hooks/useHasHover'
import { useAnchoredMenu, useClickOutside } from '@/hooks'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useCloseOnEscape } from '@/hooks/useCloseOnEscape'
import type { HeaderActionGroup, HeaderActionItem } from './headerOverflow'

export type OverflowEntry =
  | {
      kind: 'action'
      key: string
      label: string
      icon: LucideIcon
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
      /** Draws a divider above the row (the right-click menu and the ⋯ menu alike). */
      separatorBefore?: boolean
      /** Container-query class controlling when this row is visible in the kebab. */
      kebabClassName?: string
    }
  | {
      kind: 'submenu'
      key: string
      label: string
      icon: LucideIcon
      group: HeaderActionGroup
      kebabClassName?: string
    }

interface HeaderOverflowKebabProps {
  ariaLabel: string
  entries: OverflowEntry[]
  triggerClassName?: string
}

const DEFAULT_TRIGGER =
  'p-1.5 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors tap-target'

const ROW =
  'w-full flex items-center gap-3 px-3 min-h-11 py-2.5 text-start text-sm transition-colors hover:bg-fluux-hover disabled:opacity-50 disabled:cursor-not-allowed'

/** Shared item row used by both the dropdown and the touch menu. */
function ItemRow({ item, onPick }: { item: HeaderActionItem; onPick: () => void }) {
  const Icon = item.icon
  return (
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      onClick={onPick}
      className={`${ROW} ${item.danger ? 'text-fluux-error' : 'text-fluux-text'}`}
    >
      <Icon className="size-4 flex-shrink-0 text-fluux-muted" />
      <span className="flex-1">
        <span className="block">{item.label}</span>
        {item.description && (
          <span className="block text-xs text-fluux-muted">{item.description}</span>
        )}
      </span>
      {item.active && <Check className="size-4 text-fluux-brand" />}
    </button>
  )
}

export function HeaderOverflowKebab({ ariaLabel, entries, triggerClassName }: HeaderOverflowKebabProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [menuView, setMenuView] = useState<string>('root')
  const [lastSubmenu, setLastSubmenu] = useState<string | null>(null)
  const submenuTriggerRef = useRef<HTMLButtonElement>(null)
  const hasHover = useHasHover()
  const containerRef = useRef<HTMLDivElement>(null)
  const menu = useAnchoredMenu(isOpen && hasHover)
  // Responsive menu rows can be hidden; opening focus must skip them too.
  useFocusTrap(menu.menuRef, { active: isOpen && hasHover, includeShadowRoots: true })

  useClickOutside(containerRef, () => setIsOpen(false), isOpen && hasHover)

  const close = () => { setIsOpen(false); setMenuView('root'); setLastSubmenu(null) }
  const activeSubmenu = entries.find((e) => e.kind === 'submenu' && e.key === menuView)
  const inSub = activeSubmenu?.kind === 'submenu'
  const backToRoot = () => setMenuView('root')

  // Consume Escape only while open so it can't also fire the window-level
  // conversation shortcut (scroll-to-bottom / mark-read). See useCloseOnEscape.
  // Inside a submenu, Escape steps back to the root list first.
  useCloseOnEscape(inSub ? backToRoot : close, isOpen && hasHover)

  // Dropdown focus follows the view: the back row on entering a submenu, the
  // submenu's own row on returning to the root list.
  const backRowRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (!isOpen || !hasHover) return
    if (inSub) backRowRef.current?.focus({ preventScroll: true })
    else submenuTriggerRef.current?.focus({ preventScroll: true })
  }, [isOpen, hasHover, inSub, menuView])

  const preserveActivation = (event: KeyboardEvent) => {
    // Space on a menu button must not move focus to the composer before activation.
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }

  if (entries.length === 0) return null

  const trigger = (
    <button
      ref={menu.triggerRef}
      data-header-overflow-trigger
      type="button"
      onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setIsOpen((v) => !v) }}
      aria-label={ariaLabel}
      aria-haspopup={hasHover ? 'menu' : 'dialog'}
      aria-expanded={isOpen}
      className={triggerClassName ?? DEFAULT_TRIGGER}
    >
      <MoreVertical className="size-4" />
    </button>
  )

  // --- Hover / fine pointer: anchored dropdown ---------------------------------
  if (hasHover) {
    return (
      <div className="relative" ref={containerRef} onKeyDown={preserveActivation}>
        {trigger}
        {isOpen && (
          <div
            ref={menu.menuRef}
            role="menu"
            style={{ left: menu.position.x, top: menu.position.y }}
            className="fixed w-64 max-w-[calc(100vw-1rem)] fluux-popover rounded-lg z-50 py-1"
          >
            {inSub ? (
              <>
                <button
                  ref={backRowRef}
                  type="button"
                  role="menuitem"
                  onClick={backToRoot}
                  aria-label={t('common.back')}
                  className={`${ROW} text-fluux-muted mb-1 border-b border-fluux-border`}
                >
                  <ChevronLeft className="size-4 flex-shrink-0 rtl-mirror" />
                  <span className="flex-1 text-xs font-semibold">{activeSubmenu.group.title}</span>
                </button>
                {activeSubmenu.group.items.map((item) => (
                  <ItemRow key={item.key} item={item} onPick={() => { close(); item.onSelect() }} />
                ))}
              </>
            ) : entries.map((e) =>
              e.kind === 'action' ? (
                <div key={e.key} className={[e.kebabClassName, e.separatorBefore && 'mt-1 border-t border-fluux-border pt-1'].filter(Boolean).join(' ') || undefined}>
                  <ItemRow
                    item={{ key: e.key, label: e.label, icon: e.icon, danger: e.danger, disabled: e.disabled, onSelect: e.onSelect }}
                    onPick={() => { close(); e.onSelect() }}
                  />
                </div>
              ) : (
                <div key={e.key} className={e.kebabClassName}>
                  <button
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    ref={lastSubmenu === e.key ? submenuTriggerRef : undefined}
                    onClick={() => { setLastSubmenu(e.key); setMenuView(e.key) }}
                    className={`${ROW} text-fluux-text`}
                  >
                    <e.icon className="size-4 flex-shrink-0 text-fluux-muted" />
                    <span className="flex-1">{e.label}</span>
                    <ChevronRight className="size-4 text-fluux-muted rtl-mirror" />
                  </button>
                </div>
              ),
            )}
          </div>
        )}
      </div>
    )
  }

  // --- Touch: anchored menu with one level of submenus --------------------
  return (
    <div className="relative" ref={containerRef} onKeyDown={preserveActivation}>
      {trigger}
      <TouchMenu anchor={menu.triggerRef.current} open={isOpen} onClose={close}
        title={inSub ? activeSubmenu.group.title : ariaLabel} ariaLabel={ariaLabel}
        viewKey={menuView} onBack={inSub ? () => setMenuView('root') : undefined}
        returnFocusRef={submenuTriggerRef}>
        {inSub ? (
          <div role="menu" className="py-1">
            {activeSubmenu.group.items.map((item) => (
              <ItemRow key={item.key} item={item} onPick={() => { close(); item.onSelect() }} />
            ))}
          </div>
        ) : (
          <div role="menu" className="py-1">
            {entries.map((e) =>
              e.kind === 'action' ? (
                <div key={e.key} className={e.separatorBefore ? 'mt-1 border-t border-fluux-border pt-1' : undefined}>
                  <ItemRow
                    item={{ key: e.key, label: e.label, icon: e.icon, danger: e.danger, disabled: e.disabled, onSelect: e.onSelect }}
                    onPick={() => { close(); e.onSelect() }}
                  />
                </div>
              ) : (
                <button
                  key={e.key}
                  type="button"
                  ref={lastSubmenu === e.key ? submenuTriggerRef : undefined}
                  onClick={() => { setLastSubmenu(e.key); setMenuView(e.key) }}
                  className={`${ROW} text-fluux-text`}
                >
                  <e.icon className="size-4 flex-shrink-0 text-fluux-muted" />
                  <span className="flex-1">{e.label}</span>
                  <ChevronRight className="size-4 text-fluux-muted" />
                </button>
              ),
            )}
          </div>
        )}
      </TouchMenu>
    </div>
  )
}
