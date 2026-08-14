import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useXMPP, getLocalPart } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'
import { getRoomJoinReasonMessage } from '@/utils/roomJoinError'

/**
 * Surfaces an SDK error event as a toast when no better place exists to show it.
 *
 * A toast is read once and then gone, so it only fits a failure that belongs to
 * no lasting piece of the interface. Most do have one and are rendered there
 * instead: a rejected send colours its own bubble, a presence error annotates
 * its contact row, and a failed archive query marks the top of the message
 * list. The two here leave nothing behind on screen: a rejected invitation, and
 * a bookmarked room the reconnect could not rejoin.
 *
 * Should be called once in ChatLayout alongside other global effect hooks.
 */
export function useSDKErrorToasts(): void {
  const { client } = useXMPP()
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)

  useEffect(() => {
    const unsubscribers = [
      client.subscribe('room:invite-error', ({ error }) => {
        addToast('error', t('rooms.inviteRejected', { error }))
      }),
      client.subscribe('room:autojoin-error', ({ roomJid, reason, error }) => {
        addToast('error', t('rooms.couldNotRejoin', {
          room: getLocalPart(roomJid) || roomJid,
          reason: getRoomJoinReasonMessage(t, reason, error),
        }))
      }),
    ]

    return () => unsubscribers.forEach((off) => off())
  }, [client, t, addToast])
}
