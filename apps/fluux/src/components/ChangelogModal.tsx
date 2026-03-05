import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { changelog } from '@/data/changelog'

interface ChangelogModalProps {
  onClose: () => void
}

export function ChangelogModal({ onClose }: ChangelogModalProps) {
  const { t } = useTranslation()

  const getSectionTitle = (type: 'added' | 'changed' | 'fixed' | 'removed') => {
    switch (type) {
      case 'added': return t('changelog.added')
      case 'changed': return t('changelog.changed')
      case 'fixed': return t('changelog.fixed')
      case 'removed': return t('changelog.removed')
    }
  }

  const getSectionColor = (type: 'added' | 'changed' | 'fixed' | 'removed') => {
    switch (type) {
      case 'added': return 'text-green-500'
      case 'changed': return 'text-blue-500'
      case 'fixed': return 'text-amber-500'
      case 'removed': return 'text-red-500'
    }
  }

  const title = (
    <span className="flex items-center gap-2">
      <Sparkles className="w-5 h-5 text-fluux-brand" />
      {t('changelog.title')}
    </span>
  )

  return (
    <ModalShell title={title} onClose={onClose} width="max-w-lg" panelClassName="max-h-[80vh] flex flex-col">
      <div className="flex-1 overflow-y-auto p-4 space-y-6 select-text">
        {changelog.map((entry) => (
          <div key={entry.version} className="space-y-3">
            {/* Version header */}
            <div className="flex items-baseline gap-3">
              <h3 className="text-lg font-bold text-fluux-text">v{entry.version}</h3>
              <span className="text-sm text-fluux-muted">{entry.date}</span>
            </div>

            {/* Sections */}
            {entry.sections.map((section) => (
              <div key={section.type} className="space-y-1">
                <h4 className={`text-sm font-semibold uppercase ${getSectionColor(section.type)}`}>
                  {getSectionTitle(section.type)}
                </h4>
                <ul className="space-y-1 text-sm text-fluux-text">
                  {section.items.map((item, index) => (
                    <li key={index} className="flex items-start gap-2">
                      <span className="text-fluux-muted mt-1">&bull;</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))}
      </div>
    </ModalShell>
  )
}
