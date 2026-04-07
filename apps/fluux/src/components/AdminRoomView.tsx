import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Trash2, Settings, Loader2 } from 'lucide-react'
import type { AdminRoom, DataForm } from '@fluux/sdk'
import { Tooltip } from './Tooltip'
import { ConfirmDialog } from './ConfirmDialog'

interface RoomOption {
  name: string
  value: string | string[]
  label?: string
}

interface AdminRoomViewProps {
  room: AdminRoom
  onBack: () => void
  onDestroyRoom: (jid: string) => void
  isExecuting: boolean
  getRoomOptions: (roomJid: string) => Promise<DataForm>
  hasGetRoomOptionsCommand: boolean
}

// Format option names for display (snake_case to Title Case)
function formatOptionName(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// Format option values for display
function formatOptionValue(value: string | string[]): string {
  if (Array.isArray(value)) {
    return value.join(', ')
  }
  // Handle boolean-like values
  if (value === 'true') return 'Yes'
  if (value === 'false') return 'No'
  return value || '-'
}

export function AdminRoomView({
  room,
  onBack,
  onDestroyRoom,
  isExecuting,
  getRoomOptions,
  hasGetRoomOptionsCommand,
}: AdminRoomViewProps) {
  const { t } = useTranslation()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [options, setOptions] = useState<RoomOption[]>([])
  const [isLoadingOptions, setIsLoadingOptions] = useState(false)
  const [optionsError, setOptionsError] = useState<string | null>(null)

  // Load room options when component mounts
  useEffect(() => {
    if (!hasGetRoomOptionsCommand) return

    const loadOptions = async () => {
      setIsLoadingOptions(true)
      setOptionsError(null)
      try {
        const result = await getRoomOptions(room.jid)
        if (result?.fields) {
          const optionsList: RoomOption[] = result.fields
            .filter(field => field.var && field.var !== 'FORM_TYPE')
            .map(field => ({
              name: field.var,
              value: field.value ?? '',
              label: field.label || formatOptionName(field.var),
            }))
          // Sort alphabetically by label
          optionsList.sort((a, b) => a.label!.localeCompare(b.label!))
          setOptions(optionsList)
        }
      } catch (err) {
        setOptionsError(err instanceof Error ? err.message : 'Failed to load options')
      } finally {
        setIsLoadingOptions(false)
      }
    }

    void loadOptions()
  }, [room.jid, getRoomOptions, hasGetRoomOptionsCommand])

  const handleDelete = () => {
    onDestroyRoom(room.jid)
    setShowDeleteConfirm(false)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header with back button */}
      <div className="flex items-center gap-3 mb-6">
        <Tooltip content={t('common.close')} position="right">
          <button
            onClick={onBack}
            className="p-1.5 text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover
                       rounded-lg transition-colors"
            aria-label={t('common.close')}
          >
            <ArrowLeft className="w-5 h-5 rtl-mirror" />
          </button>
        </Tooltip>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-fluux-text truncate">{room.name}</h2>
          <p className="text-sm text-fluux-muted truncate">{room.jid}</p>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
        {/* Room Options Section */}
        {hasGetRoomOptionsCommand && (
          <div className="bg-fluux-bg rounded-lg p-4">
            <h3 className="text-sm font-medium text-fluux-muted mb-3 flex items-center gap-2">
              <Settings className="w-4 h-4" />
              {t('admin.roomView.options')}
            </h3>

            {isLoadingOptions ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 text-fluux-muted animate-spin" />
              </div>
            ) : optionsError ? (
              <div className="text-sm text-red-500 py-4 text-center">
                {optionsError}
              </div>
            ) : options.length === 0 ? (
              <div className="text-sm text-fluux-muted py-4 text-center">
                {t('admin.roomView.noOptions')}
              </div>
            ) : (
              <div className="space-y-2">
                {options.map((option) => (
                  <div
                    key={option.name}
                    className="flex justify-between items-start py-2 px-3 rounded-lg
                               bg-fluux-hover/50"
                  >
                    <span className="text-sm text-fluux-muted">{option.label}</span>
                    <span className="text-sm text-fluux-text text-end max-w-[60%] break-words">
                      {formatOptionValue(option.value)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Actions Section */}
        <div className="bg-fluux-bg rounded-lg p-4">
          <h3 className="text-sm font-medium text-fluux-muted mb-3">
            {t('admin.roomView.actions')}
          </h3>

          <div className="space-y-2">
            {/* Destroy Room */}
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={isExecuting}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg
                         bg-red-500/10 hover:bg-red-500/20 text-red-500
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              <span className="text-sm">{t('admin.roomView.destroy')}</span>
            </button>
          </div>
        </div>
      </div>

      {showDeleteConfirm && (
        <ConfirmDialog
          title={t('admin.roomView.confirmDestroy')}
          message={t('admin.roomView.confirmDestroyMessage', { room: room.name })}
          confirmLabel={t('admin.roomView.destroy')}
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  )
}
