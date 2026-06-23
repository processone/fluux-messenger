/**
 * Per-id notification coalescer.
 *
 * Thin alias over the SDK's keyedCoalescer (promoted there so SDK side effects
 * can reuse the same pure per-key latest-wins buffer). Kept as a named alias to
 * avoid churning useDesktopNotifications and its tests.
 */
import { createKeyedCoalescer } from '@fluux/sdk'
import type { KeyedCoalescer, CoalescedEntry } from '@fluux/sdk'

/** @deprecated import shape preserved for useDesktopNotifications. */
export type NotificationCoalescer<T> = KeyedCoalescer<string, T>
export type { CoalescedEntry }

export function createNotificationCoalescer<T>(): NotificationCoalescer<T> {
  return createKeyedCoalescer<string, T>()
}
