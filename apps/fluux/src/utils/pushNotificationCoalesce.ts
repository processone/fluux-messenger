/**
 * Pure decision logic for the service worker's push handler: tag scheme,
 * message coalescing ("N new messages"), and platform alert behavior.
 * Extracted from sw.ts so it is unit-testable without a SW runtime
 * (same pattern as notificationNavigation.ts).
 */

import { webTag } from './notificationNavigation'
import { newMessagesText } from './swMessages'

/** Parsed push payload (server JSON, or `{ body }` from a plain-text push). */
export interface PushPayloadData {
  title?: string
  body?: string
  from?: string
  type?: string
}

export interface CoalesceContext {
  /** `count` carried by the displayed notification for this tag; 0 when none. */
  existingCount: number
  /** Android Chrome supports `renotify`; each message should buzz there. */
  isAndroid: boolean
  /** BCP-47 tag for the coalesced body (SW: navigator.language). */
  locale: string
}

export interface BuiltPushNotificationOptions {
  body: string
  icon: string
  badge: string
  tag: string
  renotify?: boolean
  /** `from`/`type` feed resolveNotificationTarget on click; `count` feeds coalescing. */
  data: { from?: string; type?: string; count: number }
}

export interface BuiltPushNotification {
  title: string
  options: BuiltPushNotificationOptions
}

const DEFAULT_TITLE = 'Fluux Messenger'
const DEFAULT_BODY = 'New message'

/**
 * Notification tag for a push payload. MUST match the app-side scheme
 * (webTag) so dismissNotification closes push-generated notifications too.
 */
export function pushNotificationTag(payload: PushPayloadData): string {
  if (!payload.from) return 'default'
  return webTag(payload.type === 'room' ? 'room' : 'conversation', payload.from)
}

/**
 * Build the notification for a push. First message for a tag shows the payload
 * body; while an unread notification for the same tag is still displayed,
 * subsequent messages replace it with a localized "N new messages" body.
 * `renotify` (re-alert on replacement) is Android-only: phones should buzz per
 * message, desktop stays calm, Safari/Firefox ignore the flag anyway.
 */
export function buildPushNotification(
  payload: PushPayloadData,
  ctx: CoalesceContext,
): BuiltPushNotification {
  const count = ctx.existingCount + 1
  const body = count > 1 ? newMessagesText(ctx.locale, count) : (payload.body ?? DEFAULT_BODY)
  return {
    title: payload.title || payload.from || DEFAULT_TITLE,
    options: {
      body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: pushNotificationTag(payload),
      ...(ctx.isAndroid ? { renotify: true } : {}),
      data: { from: payload.from, type: payload.type, count },
    },
  }
}
