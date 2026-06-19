import { useEffect, useRef, useState } from 'react'
import { MoreVertical, ChevronLeft, ChevronRight, Check, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BottomSheet } from '../ui/BottomSheet'
import { useHasHover } from '@/hooks/useHasHover'
import { useAnchoredMenu, useClickOutside } from '@/hooks'
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
  'w-full flex items-center gap-3 px-3 py-2.5 text-start text-sm transition-colors hover:bg-fluux-hover disabled:opacity-50 disabled:cursor-not-allowed'

/** Shared item row used by both the dropdown and the sheet. */
function ItemRow({ item, onPick }: { item: HeaderActionItem; onPick: () => void }) {
  const Icon = item.icon
  return (
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      onClick={onPick}
      className={`${ROW} ${item.danger ? 'text-fluux-red' : 'text-fluux-text'}`}
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
  const [sheetView, setSheetView] = useState<string>('root')
  const hasHover = useHasHover()
  const containerRef = useRef<HTMLDivElement>(null)
  const menu = useAnchoredMenu(isOpen && hasHover)

  useClickOutside(containerRef, () => setIsOpen(false), isOpen && hasHover)

  useEffect(() => {
    if (!isOpen) return
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsOpen(false) }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [isOpen])

  const close = () => { setIsOpen(false); setSheetView('root') }

  if (entries.length === 0) return null

  const trigger = (
    <button
      ref={menu.triggerRef}
      type="button"
      onClick={() => setIsOpen((v) => !v)}
      aria-label={ariaLabel}
      aria-haspopup="menu"
      aria-expanded={isOpen}
      className={triggerClassName ?? DEFAULT_TRIGGER}
    >
      <MoreVertical className="size-4" />
    </button>
  )

  // --- Hover / fine pointer: anchored dropdown ---------------------------------
  if (hasHover) {
    return (
      <div className="relative" ref={containerRef}>
        {trigger}
        {isOpen && (
          <div
            ref={menu.menuRef}
            role="menu"
            style={{ left: menu.position.x, top: menu.position.y }}
            className="fixed w-64 max-w-[calc(100vw-1rem)] bg-fluux-bg border border-fluux-hover rounded-lg shadow-lg z-50 py-1"
          >
            {entries.map((e) =>
              e.kind === 'action' ? (
                <div key={e.key} className={e.kebabClassName}>
                  <ItemRow
                    item={{ key: e.key, label: e.label, icon: e.icon, danger: e.danger, disabled: e.disabled, onSelect: e.onSelect }}
                    onPick={() => { close(); e.onSelect() }}
                  />
                </div>
              ) : (
                <div key={e.key} className={e.kebabClassName}>
                  <div className="px-3 pt-2 pb-1 text-xs font-semibold text-fluux-muted">{e.group.title}</div>
                  {e.group.items.map((item) => (
                    <ItemRow key={item.key} item={item} onPick={() => { close(); item.onSelect() }} />
                  ))}
                </div>
              ),
            )}
          </div>
        )}
      </div>
    )
  }

  // --- Touch: bottom sheet with a one-level sub-sheet stack --------------------
  const activeSubmenu = entries.find((e) => e.kind === 'submenu' && e.key === sheetView)
  const inSub = activeSubmenu && activeSubmenu.kind === 'submenu'

  const sheetTitle = inSub ? (
    <button type="button" onClick={() => setSheetView('root')} aria-label={t('common.back', 'Back')} className="flex items-center gap-1 text-fluux-text">
      <ChevronLeft className="size-4" />
      <span>{activeSubmenu.group.title}</span>
    </button>
  ) : ariaLabel

  return (
    <div className="relative" ref={containerRef}>
      {trigger}
      <BottomSheet open={isOpen} onClose={close} title={sheetTitle} ariaLabel={ariaLabel}>
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
                <ItemRow
                  key={e.key}
                  item={{ key: e.key, label: e.label, icon: e.icon, danger: e.danger, disabled: e.disabled, onSelect: e.onSelect }}
                  onPick={() => { close(); e.onSelect() }}
                />
              ) : (
                <button
                  key={e.key}
                  type="button"
                  onClick={() => setSheetView(e.key)}
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
      </BottomSheet>
    </div>
  )
}
