/**
 * Types for push notifications delivered through an XMPP app server
 * (XEP-0357), such as a gateway to APNs or FCM.
 *
 * @category Push
 */

/**
 * Registration of this device with a push app server.
 */
export interface PushDeviceRegistrationRequest {
  /** JID of the app server, e.g. `pushgate.example.net` */
  appServer: string
  /** Ad-hoc command (XEP-0050) the app server registers devices with, e.g. `register-push-apns` */
  command: string
  /** Identifier of this installation; registering again with it replaces the previous token */
  deviceId: string
  /** Platform push token (APNs device token, FCM registration token) */
  token: string
}

/**
 * What the app server assigns to a registered device, passed to
 * `enable()` and `disable()`.
 */
export interface PushAppServerRegistration {
  /** App server JID the user's server publishes notifications to */
  jid: string
  /** Node on the app server identifying this device */
  node: string
  /** Secret the user's server sends with each notification, when the app server issues one */
  secret?: string
}

/**
 * XEP-0357 push status for the current session.
 * - `unknown`: support not checked yet in this session
 * - `unsupported`: the account does not advertise `urn:xmpp:push:0`
 * - `available`: the account supports push and it is not enabled by this session
 * - `enabled`: the user's server accepted the push registration
 * - `failed`: the user's server refused the push registration
 */
export type PushStatus = 'unknown' | 'unsupported' | 'available' | 'enabled' | 'failed'
