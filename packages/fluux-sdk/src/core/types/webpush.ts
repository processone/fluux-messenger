/**
 * Web Push types for ejabberd Business Edition p1:push integration.
 *
 * @category WebPush
 */

/**
 * A VAPID web push service advertised by the server.
 */
export interface WebPushService {
  /** VAPID public key (base64url encoded) */
  vapidKey: string
  /** Application identifier for push registration */
  appId: string
}

/**
 * Browser push subscription details from PushManager.subscribe().
 */
export interface WebPushRegistration {
  /** Push service endpoint URL */
  endpoint: string
  /** Client public key (base64 encoded) */
  p256dh: string
  /** Authentication secret (base64 encoded) */
  auth: string
}

/**
 * Web Push registration status.
 * - `unavailable`: Server does not support webpush or services not yet discovered
 * - `available`: Server supports webpush and VAPID services are available
 * - `registered`: Push subscription has been registered with the server
 */
export type WebPushStatus = 'unavailable' | 'available' | 'registered'
