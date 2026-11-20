/**
 * Modal for configuring an existing MUC room.
 *
 * Fetches the room's configuration form from the server and renders it as
 * sections (see RoomSettingsPanel), with the subject, notification mode,
 * links to the other room dialogs and a danger zone for room destruction
 * (owner only).
 */
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Room, DataForm } from '@fluux/sdk'
import { useXMPP } from '@fluux/sdk'
import { ModalShell } from './ModalShell'
import { ConfirmDialog } from './ConfirmDialog'
import { Loader2, AlertCircle } from 'lucide-react'
import { RoomSettingsPanel, type RoomSettingsActions } from './room-settings/RoomSettingsPanel'

interface RoomConfigModalProps extends RoomSettingsActions {
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
  ...actions
}: RoomConfigModalProps) {
  const { t } = useTranslation()
  // Direct call via the XMPP client — avoids useAdmin()'s ~15 admin store
  // subscriptions (sessions, command lists, vhosts, pagination, etc.) when
  // we only need this one fetch.
  const { client } = useXMPP()
  const getRoomOptions = useCallback(
    (roomJid: string) => client.admin.fetchRoomOptions(roomJid),
    [client]
  )

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

  const handleSave = async (formValues: Record<string, string | string[]>) => {
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
  }

  const handleDestroy = async () => {
    try {
      await destroyRoom(room.jid)
      onClose()
    } catch {
      setSaveError(t('rooms.destroyRoomError'))
    }
  }

  return (
    <ModalShell
      title={t('rooms.roomSettings')}
      onClose={onClose}
      width="max-w-4xl"
      panelClassName="h-[calc(100dvh-2rem)] md:h-[min(85vh,760px)] flex flex-col"
    >
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 text-fluux-brand animate-spin" />
        </div>
      ) : fetchError ? (
        <div className="p-4">
          <div className="flex items-start gap-2 p-3 rounded-lg border bg-red-500/10 border-red-500/30 text-red-400">
            <AlertCircle className="size-5 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{fetchError}</p>
          </div>
        </div>
      ) : configForm ? (
        <RoomSettingsPanel
          room={room}
          form={configForm}
          subject={subject}
          onSubjectChange={setSubjectValue}
          onSave={handleSave}
          onClose={onClose}
          saving={saving}
          saveError={saveError}
          isOwner={isOwner}
          onDestroyClick={() => setShowDestroyConfirm(true)}
          {...actions}
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
