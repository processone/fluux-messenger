import { getBareJid, getLocalPart, roomStore } from '@fluux/sdk'
import type { RoomInvitation, RoomVoiceRequest, SubscriptionRequest } from '@fluux/sdk'
import { isMobileTauri } from '@/utils/tauriPlatform'
import { platform } from '@/platform'
import { currentAccountId, postNativeDesktopNotification } from './nativeNotification'
import { postPluginNotification } from './postPluginNotification'
import { showWebNotification } from './webNotification'
import { webTag, type EventNavType } from './notificationNavigation'
import { notifiedEventMemory } from './notifiedEventMemory'

/** Minimal shape of the i18next `t` we rely on — avoids coupling to its generics. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/** A pending event that raises a system notification. */
export interface ActionableEvent {
  /** Identity of the event: the same unchanged event always yields the same key. */
  key: string
  navType: EventNavType
  navTarget: string
  title: string
  body: string
}

/**
 * The events store slices that notify. Messages from strangers and system
 * notifications are deliberately absent: they stay counter-only.
 */
export interface ActionableEventSources {
  subscriptionRequests: readonly SubscriptionRequest[]
  mucInvitations: readonly RoomInvitation[]
  voiceRequests: readonly RoomVoiceRequest[]
}

function roomName(roomJid: string): string {
  return roomStore.getState().getRoom(roomJid)?.name || getLocalPart(roomJid)
}

export function voiceRequestEventKey(request: RoomVoiceRequest): string {
  if (request.stanzaId) return `voice-request:${request.roomJid}:${request.stanzaId}`
  const occupant = roomStore.getState().getRoom(request.roomJid)?.occupants.get(request.nick)
  const requester = occupant?.occupantId
    ? `occupant:${occupant.occupantId}`
    : request.jid
      ? `jid:${getBareJid(request.jid)}`
      : `nick:${request.nick}`
  return `voice-request:${request.roomJid}:${requester}`
}

export function voiceRequestWasResolved(navTarget: string): boolean {
  const slash = navTarget.indexOf('/')
  if (slash === -1) return false
  const room = roomStore.getState().getRoom(navTarget.slice(0, slash))
  const occupant = room?.occupants.get(navTarget.slice(slash + 1))
  return occupant !== undefined && occupant.role !== 'visitor'
}

export function forgetVoiceRequestNotification(request: RoomVoiceRequest): void {
  const account = currentAccountId()
  if (account) notifiedEventMemory(account).forget(voiceRequestEventKey(request))
}

export function collectActionableEvents(sources: ActionableEventSources, t: TranslateFn): ActionableEvent[] {
  const events: ActionableEvent[] = []
  for (const request of sources.subscriptionRequests) {
    events.push({
      key: `contact-request:${request.from}`,
      navType: 'contact-request',
      navTarget: request.from,
      title: t('events.contactRequestTitle'),
      body: t('events.contactRequestBody', { name: getLocalPart(request.from) }),
    })
  }
  for (const invitation of sources.mucInvitations) {
    events.push({
      key: `room-invitation:${invitation.roomJid}`,
      navType: 'room-invitation',
      navTarget: invitation.roomJid,
      title: t('events.roomInvitationTitle'),
      body: t('events.roomInvitationBody', {
        name: getLocalPart(invitation.from),
        room: roomName(invitation.roomJid),
      }),
    })
  }
  for (const request of sources.voiceRequests) {
    const occupantJid = `${request.roomJid}/${request.nick}`
    events.push({
      key: voiceRequestEventKey(request),
      navType: 'voice-request',
      navTarget: occupantJid,
      title: t('events.voiceRequestTitle'),
      body: t('events.voiceRequestBody', { nick: request.nick, room: roomName(request.roomJid) }),
    })
  }
  return events
}

/**
 * Deliver one event notification: the native backend on desktop, the
 * notification plugin on mobile, otherwise the shared web helper. `onClick`
 * only serves the in-page constructor fallback; every other path routes the
 * click from `navType`/`navTarget`.
 */
export async function postActionableEventNotification(
  event: ActionableEvent,
  onClick: () => void,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const { title, body, navType, navTarget } = event
  const accountId = currentAccountId()
  if (platform().notificationsManagedByOS) {
    const mobile = await isMobileTauri()
    if (!isCurrent()) return
    if (mobile) {
      await postPluginNotification({ title, body, extra: { navType, navTarget, accountId } })
    } else {
      await postNativeDesktopNotification({
        title, body, navType, navTarget, messageId: null, accountId, avatarPath: null,
      })
    }
    return
  }
  await showWebNotification(
    title,
    { body, icon: './icon-512.png', tag: webTag(navType, navTarget, accountId), onClick },
    { from: navTarget, type: navType, accountId: accountId ?? undefined },
  )
}
