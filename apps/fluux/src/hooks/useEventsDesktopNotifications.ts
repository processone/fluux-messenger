import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { usePresence } from '@fluux/sdk'
import { useEventsStore } from '@fluux/sdk/react'
import {
  useNotificationPermission,
  getNotificationPermissionGranted,
} from './useNotificationPermission'
import { useNavigateToTarget } from './useNavigateToTarget'
import {
  collectActionableEvents,
  postActionableEventNotification,
  voiceRequestWasResolved,
  type ActionableEvent,
} from '@/utils/actionableEventNotification'
import { notifiedEventMemory } from '@/utils/notifiedEventMemory'
import { currentAccountId } from '@/utils/nativeNotification'
import { dismissNotification } from '@/utils/dismissNotification'
import { routeNotificationTarget } from '@/utils/notificationRouting'

/**
 * System notifications for pending events the user must act on: contact
 * requests, room invitations, and voice requests (which the SDK delivers only
 * to moderators of the room).
 *
 * - One notification per new event. An event observed while this hook is
 *   mounted never alerts twice, and one that already alerted in an earlier
 *   session of the same account does not alert again when redelivered.
 * - Events arriving during Do Not Disturb or without permission are skipped,
 *   and do not alert later when that changes.
 * - When an event leaves the store (accepted, declined, granted, denied), its
 *   notification is dismissed where the platform allows it.
 */
export function useEventsDesktopNotifications(): void {
  const subscriptionRequests = useEventsStore((s) => s.subscriptionRequests)
  const mucInvitations = useEventsStore((s) => s.mucInvitations)
  const voiceRequests = useEventsStore((s) => s.voiceRequests)
  const { presenceStatus } = usePresence()
  const { t } = useTranslation()
  const nav = useNavigateToTarget()
  useNotificationPermission()

  const navRef = useRef(nav)
  useEffect(() => {
    navRef.current = nav
  })

  const observedRef = useRef(new Map<string, ActionableEvent>())
  const inFlightDeliveriesRef = useRef(new Set<string>())

  useEffect(() => {
    const account = currentAccountId()
    const memory = account ? notifiedEventMemory(account) : null
    const observed = observedRef.current
    const events = collectActionableEvents({ subscriptionRequests, mucInvitations, voiceRequests }, t)
    const current = new Map(events.map((event) => [event.key, event]))

    for (const [key, event] of observed) {
      if (current.has(key)) continue
      observed.delete(key)
      if (event.navType !== 'voice-request' || voiceRequestWasResolved(event.navTarget)) {
        memory?.forget(key)
      }
      // A delivery that has not reached the platform yet dismisses itself when
      // it completes. Dismissing here as well can race that completion.
      if (!inFlightDeliveriesRef.current.has(key)) {
        void dismissNotification(event.navType, event.navTarget)
      }
    }

    const suppressed = presenceStatus === 'dnd' || !getNotificationPermissionGranted()
    for (const event of events) {
      if (observed.has(event.key)) continue
      observed.set(event.key, event)
      if (suppressed || memory?.has(event.key)) continue
      memory?.remember(event.key)
      inFlightDeliveriesRef.current.add(event.key)
      void postActionableEventNotification(event, () =>
        routeNotificationTarget(event.navType, event.navTarget, navRef.current),
        () => observedRef.current.has(event.key),
      ).finally(() => {
        inFlightDeliveriesRef.current.delete(event.key)
        if (!observedRef.current.has(event.key)) {
          void dismissNotification(event.navType, event.navTarget)
        }
      })
    }
  }, [subscriptionRequests, mucInvitations, voiceRequests, presenceStatus, t])
}
