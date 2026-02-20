import { xml, Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { getDomain } from '../jid'
import { generateUUID } from '../../utils/uuid'
import { NS_P1_PUSH, NS_P1_PUSH_WEBPUSH } from '../namespaces'
import { logInfo, logWarn } from '../logger'
import type { WebPushService } from '../types'

/**
 * Web Push notification module for ejabberd Business Edition.
 *
 * Handles discovery and registration of VAPID-based web push notifications
 * via the p1:push protocol. This allows the server to send push notifications
 * through browser push services (FCM, Mozilla, Apple) when the client is
 * offline or the app is in the background.
 *
 * @remarks
 * Push registration is only needed on fresh sessions — the server retains
 * the registration across Stream Management (XEP-0198) resumptions.
 *
 * The module handles the XMPP protocol side. Browser-specific logic
 * (ServiceWorker, PushManager) lives in the app layer.
 *
 * @example
 * ```typescript
 * // Query available push services
 * const services = await client.webPush.queryServices()
 *
 * // Register a push subscription (after PushManager.subscribe())
 * await client.webPush.registerSubscription(endpoint, p256dh, auth, appId)
 * ```
 *
 * @category Modules
 */
export class WebPush extends BaseModule {
  handle(_stanza: Element): boolean | void {
    // WebPush doesn't handle incoming stanzas (responses handled via IQ caller)
    return false
  }

  /**
   * Query available VAPID web push services from the server.
   *
   * Sends a `<services xmlns='p1:push:webpush'/>` IQ to discover
   * configured push services with their VAPID public keys.
   *
   * @returns Array of available web push services
   */
  async queryServices(): Promise<WebPushService[]> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return []

    const domain = getDomain(currentJid)
    if (!domain) return []

    const iq = xml(
      'iq',
      { type: 'get', to: domain, id: `webpush_svc_${generateUUID()}` },
      xml('services', { xmlns: NS_P1_PUSH_WEBPUSH })
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const servicesEl = result.getChild('services', NS_P1_PUSH_WEBPUSH)
      if (!servicesEl) return []

      const services: WebPushService[] = servicesEl.getChildren('service')
        .map((svc: Element) => ({
          vapidKey: svc.attrs.vapid || '',
          appId: svc.attrs.appid || '',
        }))
        .filter(s => s.vapidKey && s.appId)

      this.deps.emitSDK('connection:webpush-services', { services })
      logInfo(`Web Push: ${services.length} VAPID service(s) discovered`)
      this.deps.emitSDK('console:event', {
        message: `Web Push: ${services.length} VAPID service(s) available`,
        category: 'connection',
      })

      return services
    } catch (err) {
      logWarn(`Web Push service query failed: ${err instanceof Error ? err.message : String(err)}`)
      this.deps.emitSDK('connection:webpush-services', { services: [] })
      return []
    }
  }

  /**
   * Register a web push subscription with the server.
   *
   * Sends a `<push xmlns='p1:push'>` IQ with the browser push subscription
   * details (endpoint, p256dh key, auth secret) to register for push
   * notifications.
   *
   * @param endpoint - Push service endpoint URL from PushSubscription
   * @param p256dh - Client public key (base64 encoded) from PushSubscription.getKey('p256dh')
   * @param auth - Authentication secret (base64 encoded) from PushSubscription.getKey('auth')
   * @param appId - Application identifier from the VAPID service
   */
  async registerSubscription(
    endpoint: string,
    p256dh: string,
    auth: string,
    appId: string
  ): Promise<void> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) throw new Error('Not connected')

    const domain = getDomain(currentJid)
    if (!domain) throw new Error('No server domain')

    // Build the notification ID as endpoint#p256dh#auth
    const notificationId = `${endpoint}#${p256dh}#${auth}`

    const iq = xml(
      'iq',
      { type: 'set', to: domain, id: `webpush_reg_${generateUUID()}` },
      xml('push', { xmlns: NS_P1_PUSH },
        xml('body', { send: 'all', groupchat: 'true', from: 'name' }),
        xml('offline', {}, 'true'),
        xml('notification', {},
          xml('type', {}, 'webpush'),
          xml('id', {}, notificationId),
        ),
        xml('appid', {}, appId),
      )
    )

    try {
      await this.deps.sendIQ(iq)
      this.deps.emitSDK('connection:webpush-status', { status: 'registered' })
      logInfo('Web Push: subscription registered with server')
      this.deps.emitSDK('console:event', {
        message: 'Web Push subscription registered',
        category: 'connection',
      })
    } catch (err) {
      logWarn(`Web Push registration failed: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  }
}
