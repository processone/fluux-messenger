import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Key, Loader2, Star } from 'lucide-react'
import type { KeyBundle } from '../e2ee/OpenPGPPluginBase'

interface KeyPickerDialogProps {
  candidates: KeyBundle[]
  onConfirm: (fingerprint: string) => Promise<void>
  onCancel: () => void
}

export function KeyPickerDialog({ candidates, onConfirm, onCancel }: KeyPickerDialogProps) {
  const { t, i18n } = useTranslation()
  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  const sorted = [...candidates].sort((a, b) => {
    const da = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const db = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return db - da
  })
  const [selected, setSelected] = useState(sorted[0]?.fingerprint ?? '')
  const [isInstalling, setIsInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isInstalling) onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, isInstalling])

  const handleConfirm = useCallback(async () => {
    if (!selected) return
    setIsInstalling(true)
    setError(null)
    try {
      await onConfirm(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIsInstalling(false)
    }
  }, [onConfirm, selected])

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(i18n.language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    } catch {
      return iso.slice(0, 10)
    }
  }

  return (
    <div
      data-modal="true"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onMouseDown={(e) => {
        mouseDownTargetRef.current = e.target
      }}
      onClick={(e) => {
        if (isInstalling) return
        if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) {
          onCancel()
        }
      }}
    >
      <div className="bg-fluux-sidebar rounded-lg max-w-md w-full mx-4 shadow-xl max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden">
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-lg font-semibold text-fluux-text mb-1">
            {t('settings.encryption.keyPicker.title')}
          </h3>
          <p className="text-sm text-fluux-muted">
            {t('settings.encryption.keyPicker.body')}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-5">
          <div className="space-y-2 mb-4">
            {sorted.map((bundle, idx) => (
              <label
                key={bundle.fingerprint}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  selected === bundle.fingerprint
                    ? 'border-fluux-brand bg-fluux-brand/10'
                    : 'border-fluux-hover bg-fluux-bg hover:border-fluux-active'
                } ${isInstalling ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <input
                  type="radio"
                  name="key-picker"
                  value={bundle.fingerprint}
                  checked={selected === bundle.fingerprint}
                  disabled={isInstalling}
                  onChange={() => setSelected(bundle.fingerprint)}
                  className="accent-fluux-brand"
                />
                <Key className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-fluux-text truncate">
                      …{bundle.fingerprint.slice(-8).toUpperCase()}
                    </span>
                    {idx === 0 && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-fluux-brand">
                        <Star className="w-3 h-3" />
                        {t('settings.encryption.keyPicker.recommended')}
                      </span>
                    )}
                  </div>
                  {bundle.createdAt && (
                    <span className="text-[11px] text-fluux-muted">
                      {t('settings.encryption.keyPicker.created')}{' '}
                      {formatDate(bundle.createdAt)}
                    </span>
                  )}
                </div>
              </label>
            ))}
          </div>

          {error && (
            <p className="text-xs text-red-500 dark:text-red-400 mb-3 break-words">
              {error}
            </p>
          )}
        </div>

        <div className="px-5 pb-5 pt-3 flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={isInstalling}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selected || isInstalling}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isInstalling && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {t('settings.encryption.keyPicker.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
