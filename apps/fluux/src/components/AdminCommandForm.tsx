import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { DataForm } from '@fluux/sdk'
import { AlertCircle, Info, AlertTriangle, User, X } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { FormField } from './DataFormFields'

interface AdminCommandFormProps {
  form: DataForm
  onSubmit: (formData: Record<string, string | string[]>) => void
  onCancel: () => void
  onPrev?: () => void
  isSubmitting?: boolean
  note?: { type: 'info' | 'warn' | 'error'; text: string }
  canGoBack?: boolean
  canGoNext?: boolean
  /** Pre-filled JID for user-targeted commands */
  targetJid?: string | null
  /** Callback to clear the target JID */
  onClearTargetJid?: () => void
}

export function AdminCommandForm({
  form,
  onSubmit,
  onCancel,
  onPrev,
  isSubmitting = false,
  note,
  canGoBack = false,
  canGoNext = false,
  targetJid,
  onClearTargetJid,
}: AdminCommandFormProps) {
  const { t } = useTranslation()

  // Initialize form state from field values, pre-filling accountjid if targetJid is set
  const [formData, setFormData] = useState<Record<string, string | string[]>>(() => {
    const initial: Record<string, string | string[]> = {}
    for (const field of form.fields) {
      if (field.type === 'hidden' || field.type === 'fixed') continue
      // Pre-fill accountjid with targetJid
      if (field.var === 'accountjid' && targetJid) {
        initial[field.var] = targetJid
      } else {
        initial[field.var] = field.value ?? (field.type === 'list-multi' || field.type === 'jid-multi' || field.type === 'text-multi' ? [] : '')
      }
    }
    return initial
  })

  const handleChange = useCallback((fieldVar: string, value: string | string[]) => {
    setFormData(prev => ({ ...prev, [fieldVar]: value }))
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    // Include hidden field values in submission
    const submitData: Record<string, string | string[]> = { ...formData }
    for (const field of form.fields) {
      if (field.type === 'hidden' && field.value) {
        submitData[field.var] = field.value
      }
    }

    onSubmit(submitData)
  }

  // Filter out hidden fields for display
  // Also filter out accountjid when targetJid is set (shown separately at top)
  const visibleFields = form.fields.filter(f => {
    if (f.type === 'hidden') return false
    if (f.var === 'accountjid' && targetJid) return false
    return true
  })

  return (
    <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
      {/* Form title and instructions */}
      {form.title && (
        <h3 className="text-lg font-semibold text-fluux-text mb-2">{form.title}</h3>
      )}
      {form.instructions && form.instructions.length > 0 && (
        <div className="mb-4 text-sm text-fluux-muted">
          {form.instructions.map((instr, i) => (
            <p key={i}>{instr}</p>
          ))}
        </div>
      )}

      {/* Target user display (when pre-filled) */}
      {targetJid && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-fluux-bg border border-fluux-hover mb-4">
          <User className="w-5 h-5 text-fluux-muted flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-fluux-muted">{t('admin.targetUser')}</p>
            <p className="text-sm text-fluux-text font-medium truncate">{targetJid}</p>
          </div>
          {onClearTargetJid && (
            <Tooltip content={t('admin.changeUser')} position="left">
              <button
                type="button"
                onClick={onClearTargetJid}
                className="p-1 text-fluux-muted hover:text-fluux-text rounded transition-colors"
                aria-label={t('admin.changeUser')}
              >
                <X className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
        </div>
      )}

      {/* Note display */}
      {note && <NoteDisplay note={note} />}

      {/* Form fields */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
        {visibleFields.map(field => (
          <FormField
            key={field.var}
            field={field}
            value={formData[field.var]}
            onChange={handleChange}
            disabled={isSubmitting}
          />
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-fluux-bg">
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          className="px-4 py-2 text-sm text-fluux-text bg-fluux-bg hover:bg-fluux-hover rounded-lg transition-colors disabled:opacity-50"
        >
          {t('common.cancel')}
        </button>
        {canGoBack && onPrev && (
          <button
            type="button"
            onClick={onPrev}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-bg hover:bg-fluux-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {t('admin.previous')}
          </button>
        )}
        <button
          type="submit"
          disabled={isSubmitting}
          className="px-4 py-2 text-sm text-white bg-fluux-brand hover:bg-fluux-brand/90 rounded-lg transition-colors disabled:opacity-50"
        >
          {isSubmitting ? t('admin.executing') : canGoNext ? t('admin.next') : t('admin.execute')}
        </button>
      </div>
    </form>
  )
}

function NoteDisplay({ note }: { note: { type: 'info' | 'warn' | 'error'; text: string } }) {
  const icons = {
    info: Info,
    warn: AlertTriangle,
    error: AlertCircle,
  }
  const styles = {
    info: 'bg-blue-500/10 border-blue-500/30 text-blue-400',
    warn: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400',
    error: 'bg-red-500/10 border-red-500/30 text-red-400',
  }
  const Icon = icons[note.type]

  return (
    <div className={`flex items-start gap-2 p-3 rounded-lg border mb-4 ${styles[note.type]}`}>
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
      <p className="text-sm">{note.text}</p>
    </div>
  )
}

// Result display component for completed commands
interface AdminCommandResultProps {
  form: DataForm
  note?: { type: 'info' | 'warn' | 'error'; text: string }
  onClose: () => void
}

export function AdminCommandResult({ form, note, onClose }: AdminCommandResultProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {form.title && (
        <h3 className="text-lg font-semibold text-fluux-text mb-2">{form.title}</h3>
      )}

      {note && <NoteDisplay note={note} />}

      <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
        {form.fields.filter(f => f.type !== 'hidden').map(field => (
          <div key={field.var} className="space-y-1">
            {field.type === 'fixed' ? (
              <p className="text-sm text-fluux-muted">{field.value || field.label}</p>
            ) : (
              <>
                <p className="text-sm font-medium text-fluux-text">{field.label || field.var}</p>
                <p className="text-sm text-fluux-muted">
                  {Array.isArray(field.value)
                    ? field.value.join(', ') || t('admin.noValue')
                    : field.value || t('admin.noValue')
                  }
                </p>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="flex justify-end pt-4 mt-4 border-t border-fluux-bg">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-white bg-fluux-brand hover:bg-fluux-brand/90 rounded-lg transition-colors"
        >
          {t('common.close')}
        </button>
      </div>
    </div>
  )
}
