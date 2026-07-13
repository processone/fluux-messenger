import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { SlashCommand } from '../../commands/types'

interface CommandHelpPanelProps {
  commands: SlashCommand[]
  onClose: () => void
}

/** Transient panel listing available commands. Rendered through `aboveInput`. */
export function CommandHelpPanel({ commands, onClose }: CommandHelpPanelProps) {
  const { t } = useTranslation()
  return (
    <div className="absolute bottom-full inset-x-0 mb-1 max-h-64 overflow-y-auto fluux-popover rounded-lg z-30 p-2">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-sm font-semibold text-fluux-text">{t('commands.help.title')}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="p-1 rounded hover:bg-fluux-hover text-fluux-muted"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <ul>
        {commands.map((cmd) => (
          <li key={cmd.name} className="px-1 py-1">
            <span className="text-sm font-medium text-fluux-text">
              {cmd.usageKey ? t(cmd.usageKey) : `/${cmd.name}`}
            </span>
            {cmd.descriptionKey ? (
              <span className="block text-xs text-fluux-muted">{t(cmd.descriptionKey)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
