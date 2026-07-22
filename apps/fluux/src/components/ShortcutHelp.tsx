import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { ModalOverlay } from './ModalOverlay'
import { type ShortcutDefinition, formatShortcutKey } from '@/hooks/useKeyboardShortcuts'

interface ShortcutHelpProps {
  shortcuts: ShortcutDefinition[]
  onClose: () => void
}

export function ShortcutHelp({ shortcuts, onClose }: ShortcutHelpProps) {
  const { t } = useTranslation()
  // Note: Escape to close is handled by the global escape hierarchy in useKeyboardShortcuts

  // Group shortcuts by category
  const groupedShortcuts = shortcuts.reduce((acc, shortcut) => {
    if (!acc[shortcut.category]) {
      acc[shortcut.category] = []
    }
    acc[shortcut.category].push(shortcut)
    return acc
  }, {} as Record<string, ShortcutDefinition[]>)

  const categoryTitles: Record<string, string> = {
    general: t('shortcuts.general'),
    navigation: t('shortcuts.navigation'),
    actions: t('shortcuts.actions'),
  }

  const categoryOrder = ['general', 'navigation', 'actions']

  return (
    // Escape to close is handled by the global escape hierarchy in
    // useKeyboardShortcuts, so the overlay does not also bind it.
    <ModalOverlay
      onClose={onClose}
      width="max-w-lg"
      panelClassName="max-h-[80vh] overflow-hidden flex flex-col"
      closeOnEscape={false}
    >
      {({ close }) => (
        <>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-fluux-border">
          <h2 className="text-lg font-semibold text-fluux-text">{t('shortcuts.title')}</h2>
          <Tooltip content={t('common.close')} position="left">
            <button
              type="button"
              onClick={close}
              className="p-1.5 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors"
              aria-label={t('common.close')}
            >
              <X className="size-5" />
            </button>
          </Tooltip>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {categoryOrder.map((category) => {
            const categoryShortcuts = groupedShortcuts[category]
            if (!categoryShortcuts || categoryShortcuts.length === 0) return null

            return (
              <div key={category}>
                <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wider mb-3">
                  {categoryTitles[category] || category}
                </h3>
                <div className="space-y-2">
                  {categoryShortcuts.map((shortcut, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between py-1.5"
                    >
                      <span className="text-fluux-text">{t(shortcut.description)}</span>
                      <kbd className="px-2 py-1 bg-fluux-bg rounded text-sm font-mono text-fluux-muted border border-fluux-border">
                        {formatShortcutKey(shortcut)}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-fluux-border text-center">
          <span className="text-sm text-fluux-muted">
            {t('shortcuts.pressEscToClose')}
          </span>
        </div>
        </>
      )}
    </ModalOverlay>
  )
}
