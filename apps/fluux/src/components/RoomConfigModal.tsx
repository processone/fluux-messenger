/**
 * Modal for configuring an existing MUC room.
 *
 * Fetches the room's configuration form from the server, renders it
 * with a subject field on top, and provides a danger zone for room
 * destruction (owner only).
 */
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Room, DataForm } from '@fluux/sdk'
import { useAdmin } from '@fluux/sdk'
import { ModalShell } from './ModalShell'
import { ConfirmDialog } from './ConfirmDialog'
import { FormField, useDataFormState } from './DataFormFields'
import { Loader2, AlertCircle, Trash2 } from 'lucide-react'

interface RoomConfigModalProps {
  room: Room
  onClose: () => void
  submitRoomConfig: (roomJid: string, values: Record<string, string | string[]>) => Promise<void>
  setSubject: (roomJid: string, subject: string) => Promise<void>
  destroyRoom: (roomJid: string, reason?: string) => Promise<void>
}

export function RoomConfigModal({
  room,
  onClose,
  submitRoomConfig,
  setSubject,
  destroyRoom,
}: RoomConfigModalProps) {
  const { t } = useTranslation()
  const { getRoomOptions } = useAdmin()

  const [configForm, setConfigForm] = useState<DataForm | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [subject, setSubjectValue] = useState(room.subject || '')
  const [showDestroyConfirm, setShowDestroyConfirm] = useState(false)

  // Check if user is owner
  const selfOccupant = room.nickname ? room.occupants.get(room.nickname) : undefined
  const isOwner = selfOccupant?.affiliation === 'owner'

  // Fetch config form on mount
  useEffect(() => {
    let cancelled = false
    async function fetchConfig() {
      try {
        const form = await getRoomOptions(room.jid)
        if (!cancelled) {
          setConfigForm(form)
          setLoading(false)
        }
      } catch {
        if (!cancelled) {
          setFetchError(t('rooms.fetchConfigError'))
          setLoading(false)
        }
      }
    }
    void fetchConfig()
    return () => { cancelled = true }
  }, [room.jid, getRoomOptions, t])

  const handleSave = useCallback(async (formValues: Record<string, string | string[]>) => {
    setSaving(true)
    setSaveError(null)
    try {
      // Submit subject change if modified
      const originalSubject = room.subject || ''
      if (subject !== originalSubject) {
        await setSubject(room.jid, subject)
      }

      // Submit config form
      await submitRoomConfig(room.jid, formValues)
      onClose()
    } catch {
      setSaveError(t('rooms.saveConfigError'))
    } finally {
      setSaving(false)
    }
  }, [room.jid, room.subject, subject, setSubject, submitRoomConfig, onClose, t])

  const handleDestroy = useCallback(async () => {
    try {
      await destroyRoom(room.jid)
      onClose()
    } catch {
      setSaveError(t('rooms.destroyRoomError'))
    }
  }, [room.jid, destroyRoom, onClose, t])

  return (
    <ModalShell
      title={t('rooms.roomSettings')}
      onClose={onClose}
      width="max-w-md"
      panelClassName="max-h-[80vh] flex flex-col"
    >
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-fluux-brand animate-spin" />
        </div>
      ) : fetchError ? (
        <div className="p-4">
          <div className="flex items-start gap-2 p-3 rounded-lg border bg-red-500/10 border-red-500/30 text-red-400">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{fetchError}</p>
          </div>
        </div>
      ) : configForm ? (
        <ConfigFormContent
          form={configForm}
          roomJid={room.jid}
          subject={subject}
          onSubjectChange={setSubjectValue}
          onSave={handleSave}
          onClose={onClose}
          saving={saving}
          saveError={saveError}
          isOwner={isOwner}
          onDestroyClick={() => setShowDestroyConfirm(true)}
        />
      ) : null}

      {/* Destroy confirmation dialog */}
      {showDestroyConfirm && (
        <ConfirmDialog
          title={t('rooms.destroyRoom')}
          message={t('rooms.destroyRoomConfirm')}
          confirmLabel={t('rooms.destroyRoom')}
          onConfirm={handleDestroy}
          onCancel={() => setShowDestroyConfirm(false)}
          variant="danger"
        />
      )}
    </ModalShell>
  )
}

interface ConfigFormContentProps {
  form: DataForm
  roomJid: string
  subject: string
  onSubjectChange: (value: string) => void
  onSave: (formValues: Record<string, string | string[]>) => void
  onClose: () => void
  saving: boolean
  saveError: string | null
  isOwner: boolean
  onDestroyClick: () => void
}

function ConfigFormContent({
  form,
  roomJid,
  subject,
  onSubjectChange,
  onSave,
  onClose,
  saving,
  saveError,
  isOwner,
  onDestroyClick,
}: ConfigFormContentProps) {
  const { t } = useTranslation()
  const { formData, handleChange, getSubmitValues } = useDataFormState(form)

  const visibleFields = form.fields.filter(f => f.type !== 'hidden')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave(getSubmitValues())
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        {/* Subject field (custom, not part of server form) */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-fluux-text">
            {t('rooms.subject')}
          </label>
          <input
            type="text"
            value={subject}
            onChange={e => onSubjectChange(e.target.value)}
            disabled={saving}
            placeholder={roomJid}
            className="w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text placeholder-fluux-muted focus:outline-none focus:ring-2 focus:ring-fluux-brand/50 disabled:opacity-50"
          />
        </div>

        {/* Divider */}
        {visibleFields.length > 0 && (
          <div className="border-t border-fluux-hover" />
        )}

        {/* Dynamic server fields */}
        {visibleFields.map(field => (
          <FormField
            key={field.var}
            field={field}
            value={formData[field.var]}
            onChange={handleChange}
            disabled={saving}
          />
        ))}

        {/* Danger Zone (owner only) */}
        {isOwner && (
          <>
            <div className="border-t border-fluux-hover mt-4" />
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-red-400">{t('rooms.dangerZone')}</h4>
              <button
                type="button"
                onClick={onDestroyClick}
                disabled={saving}
                className="flex items-center gap-2 px-3 py-2 text-sm text-red-400 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" />
                {t('rooms.destroyRoom')}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Save error */}
      {saveError && (
        <div className="mx-4 mb-2 flex items-start gap-2 p-3 rounded-lg border bg-red-500/10 border-red-500/30 text-red-400">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <p className="text-sm">{saveError}</p>
        </div>
      )}

      {/* Footer buttons */}
      <div className="flex justify-end gap-2 px-4 py-3 border-t border-fluux-hover flex-shrink-0">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="px-4 py-2 text-sm text-fluux-text bg-fluux-bg hover:bg-fluux-hover rounded-lg transition-colors disabled:opacity-50"
        >
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 text-sm text-white bg-fluux-brand hover:bg-fluux-brand/90 rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? t('rooms.savingSettings') : t('rooms.saveSettings')}
        </button>
      </div>
    </form>
  )
}
