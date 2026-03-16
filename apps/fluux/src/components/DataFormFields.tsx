/**
 * Reusable XEP-0004 Data Form field renderer and state management.
 *
 * Extracted from AdminCommandForm for reuse in room configuration
 * and other data form contexts.
 */
import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { DataForm, DataFormField } from '@fluux/sdk'
import { HelpCircle } from 'lucide-react'
import { Tooltip } from './Tooltip'

/**
 * Hook to manage data form state.
 *
 * Initializes form values from a DataForm, returns state and handlers.
 */
export function useDataFormState(form: DataForm) {
  const [formData, setFormData] = useState<Record<string, string | string[]>>(() => {
    const initial: Record<string, string | string[]> = {}
    for (const field of form.fields) {
      if (field.type === 'hidden' || field.type === 'fixed') continue
      initial[field.var] = field.value ?? (
        field.type === 'list-multi' || field.type === 'jid-multi' || field.type === 'text-multi'
          ? []
          : ''
      )
    }
    return initial
  })

  const handleChange = useCallback((fieldVar: string, value: string | string[]) => {
    setFormData(prev => ({ ...prev, [fieldVar]: value }))
  }, [])

  const getSubmitValues = useCallback((): Record<string, string | string[]> => {
    const submitData: Record<string, string | string[]> = { ...formData }
    for (const field of form.fields) {
      if (field.type === 'hidden' && field.value) {
        submitData[field.var] = field.value
      }
    }
    return submitData
  }, [formData, form.fields])

  return { formData, handleChange, getSubmitValues }
}

interface FormFieldProps {
  field: DataFormField
  value: string | string[] | undefined
  onChange: (fieldVar: string, value: string | string[]) => void
  disabled?: boolean
}

/**
 * Renders a single XEP-0004 Data Form field as the appropriate input element.
 */
export function FormField({ field, value, onChange, disabled }: FormFieldProps) {
  const { t } = useTranslation()

  // Fixed fields are display-only
  if (field.type === 'fixed') {
    return (
      <div className="text-sm text-fluux-muted italic">
        {field.value || field.label}
      </div>
    )
  }

  const label = field.label || field.var
  const isRequired = field.required
  const desc = field.desc || t(`dataFormHints.${field.var}`, { defaultValue: '' }) || undefined

  const renderInput = () => {
    switch (field.type) {
      case 'text-single':
      case 'jid-single':
        return (
          <input
            type="text"
            value={(value as string) || ''}
            onChange={e => onChange(field.var, e.target.value)}
            disabled={disabled}
            required={isRequired}
            placeholder={field.desc}
            className="w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text placeholder-fluux-muted focus:outline-none focus:ring-2 focus:ring-fluux-brand/50 disabled:opacity-50"
          />
        )

      case 'text-private':
        return (
          <input
            type="password"
            value={(value as string) || ''}
            onChange={e => onChange(field.var, e.target.value)}
            disabled={disabled}
            required={isRequired}
            placeholder={field.desc}
            className="w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text placeholder-fluux-muted focus:outline-none focus:ring-2 focus:ring-fluux-brand/50 disabled:opacity-50"
          />
        )

      case 'text-multi':
      case 'jid-multi':
        return (
          <textarea
            value={Array.isArray(value) ? value.join('\n') : (value as string) || ''}
            onChange={e => onChange(field.var, e.target.value.split('\n'))}
            disabled={disabled}
            required={isRequired}
            placeholder={field.desc || (field.type === 'jid-multi' ? t('admin.oneJidPerLine') : t('admin.onePerLine'))}
            rows={4}
            className="w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text placeholder-fluux-muted focus:outline-none focus:ring-2 focus:ring-fluux-brand/50 disabled:opacity-50 resize-y"
          />
        )

      case 'list-single':
        return (
          <select
            value={(value as string) || ''}
            onChange={e => onChange(field.var, e.target.value)}
            disabled={disabled}
            required={isRequired}
            className="w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text focus:outline-none focus:ring-2 focus:ring-fluux-brand/50 disabled:opacity-50"
          >
            <option value="">{t('admin.selectOption')}</option>
            {field.options?.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label || opt.value}
              </option>
            ))}
          </select>
        )

      case 'list-multi':
        return (
          <div className="space-y-1 max-h-40 overflow-y-auto p-2 bg-fluux-bg border border-fluux-border rounded-lg">
            {field.options?.map(opt => {
              const selected = Array.isArray(value) && value.includes(opt.value)
              return (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer hover:bg-fluux-hover px-2 py-1 rounded">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={e => {
                      const current = Array.isArray(value) ? value : []
                      if (e.target.checked) {
                        onChange(field.var, [...current, opt.value])
                      } else {
                        onChange(field.var, current.filter(v => v !== opt.value))
                      }
                    }}
                    disabled={disabled}
                    className="rounded border-fluux-border text-fluux-brand focus:ring-fluux-brand/50"
                  />
                  <span className="text-sm text-fluux-text">{opt.label || opt.value}</span>
                </label>
              )
            })}
          </div>
        )

      case 'boolean':
        return (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={value === 'true' || value === '1'}
              onChange={e => onChange(field.var, e.target.checked ? '1' : '0')}
              disabled={disabled}
              className="rounded border-fluux-border text-fluux-brand focus:ring-fluux-brand/50"
            />
            <span className="text-sm text-fluux-muted">{label}</span>
            {desc && (
              <Tooltip content={desc} position="top">
                <HelpCircle className="w-3.5 h-3.5 text-fluux-muted cursor-help flex-shrink-0" />
              </Tooltip>
            )}
          </label>
        )

      default:
        return (
          <input
            type="text"
            value={(value as string) || ''}
            onChange={e => onChange(field.var, e.target.value)}
            disabled={disabled}
            className="w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text focus:outline-none focus:ring-2 focus:ring-fluux-brand/50 disabled:opacity-50"
          />
        )
    }
  }

  return (
    <div className="space-y-1">
      {field.type !== 'boolean' && (
        <label className="flex items-center gap-1 text-sm font-medium text-fluux-text">
          {label}
          {isRequired && <span className="text-red-400 ml-0.5">*</span>}
          {desc && (
            <Tooltip content={desc} position="top">
              <HelpCircle className="w-3.5 h-3.5 text-fluux-muted cursor-help" />
            </Tooltip>
          )}
        </label>
      )}
      {renderInput()}
    </div>
  )
}
