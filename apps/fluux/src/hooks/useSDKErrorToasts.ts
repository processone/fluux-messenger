import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useXMPP } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'

/**
 * Subscribes to SDK error events and surfaces them as toast notifications.
 *
 * Currently handles:
 * - `room:invite-error` — MUC invitation rejected by server (e.g., forbidden)
 *
 * Should be called once in ChatLayout alongside other global effect hooks.
 */
export function useSDKErrorToasts(): void {
  const { client } = useXMPP()
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)

  useEffect(() => {
    const unsubscribe = client.subscribe('room:invite-error', ({ error }) => {
      addToast('error', t('rooms.inviteRejected', { error }))
    })

    return unsubscribe
  }, [client, t, addToast])
}
