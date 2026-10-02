import { xml, type Element } from '@xmpp/client'
import { WebPush } from './WebPush'
import { generateUUID } from '../../utils/uuid'
import { getBareJid } from '../jid'
import { buildDataFormSubmit, getFormFieldValue, parseDataForm } from '../../utils/dataForm'
import { NS_COMMANDS, NS_DISCO_INFO, NS_PUBSUB_PUBLISH_OPTIONS, NS_PUSH } from '../namespaces'
import { logInfo, logWarn } from '../logger'
import type { PushAppServerRegistration, PushDeviceRegistrationRequest } from '../types'

/**
 * Push notifications, through an app server (XEP-0357) or ejabberd Business
 * Edition Web Push (`p1:push`, inherited from {@link WebPush}).
 *
 * With an app server, the device first registers its platform token with the
 * app server, then asks the user's server to publish notifications to the node
 * the app server assigned:
 *
 * @example
 * ```typescript
 * declare const token: string
 *
 * const registration = await client.push.registerDevice({
 *   appServer: 'pushgate.example.net',
 *   command: 'register-push-apns',
 *   deviceId: 'installation-uuid',
 *   token,
 * })
 * await client.push.enable(registration)
 * ```
 *
 * A registration lasts across Stream Management (XEP-0198) resumptions; a
 * fresh session registers again.
 *
 * @category Modules
 */
export class Push extends WebPush {
  /**
   * Whether the account supports XEP-0357, from disco#info on its bare JID.
   * A failed query counts as unsupported.
   */
  async checkSupport(): Promise<boolean> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return false

    const iq = xml(
      'iq',
      { type: 'get', to: getBareJid(currentJid), id: `push_disco_${generateUUID()}` },
      xml('query', { xmlns: NS_DISCO_INFO })
    )

    let supported = false
    try {
      const result = await this.deps.sendIQ(iq)
      supported = (result.getChild('query', NS_DISCO_INFO)?.getChildren('feature') ?? [])
        .some((feature: Element) => feature.attrs.var === NS_PUSH)
    } catch (err) {
      logWarn(`Push support query failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.deps.emitSDK('connection:push-status', { status: supported ? 'available' : 'unsupported' })
    return supported
  }

  /**
   * Registers this device's platform token with the app server, which
   * answers with the node (and secret) to pass to {@link enable}.
   */
  async registerDevice(request: PushDeviceRegistrationRequest): Promise<PushAppServerRegistration> {
    const iq = xml(
      'iq',
      { type: 'set', to: request.appServer, id: `push_reg_${generateUUID()}` },
      xml('command', { xmlns: NS_COMMANDS, node: request.command, action: 'execute' },
        buildDataFormSubmit({ 'device-id': request.deviceId, token: request.token })
      )
    )

    try {
      const registration = parseRegistration(await this.deps.sendIQ(iq), request.appServer)
      logInfo(`Push: device registered with ${request.appServer}`)
      return registration
    } catch (err) {
      this.reportFailure(`Push registration with ${request.appServer} failed`, err)
      throw err
    }
  }

  /** Asks the user's server to publish notifications to the app server node. */
  async enable(registration: PushAppServerRegistration): Promise<void> {
    const options = registration.secret
      ? [buildDataFormSubmit({ secret: registration.secret }, NS_PUBSUB_PUBLISH_OPTIONS)]
      : []
    const iq = xml(
      'iq',
      { type: 'set', id: `push_enable_${generateUUID()}` },
      xml('enable', { xmlns: NS_PUSH, jid: registration.jid, node: registration.node }, ...options)
    )

    try {
      await this.deps.sendIQ(iq)
    } catch (err) {
      this.reportFailure(`Push enable via ${registration.jid} failed`, err)
      throw err
    }
    this.deps.emitSDK('connection:push-status', { status: 'enabled' })
    this.deps.emitSDK('console:event', { message: `Push enabled via ${registration.jid}`, category: 'connection' })
  }

  private reportFailure(context: string, err: unknown): void {
    const message = `${context}: ${err instanceof Error ? err.message : String(err)}`
    logWarn(message)
    this.deps.emitSDK('connection:push-status', { status: 'failed' })
    this.deps.emitSDK('console:event', { message, category: 'connection' })
  }

  /** Stops the user's server from publishing to the app server node. */
  async disable(registration: PushAppServerRegistration): Promise<void> {
    const iq = xml(
      'iq',
      { type: 'set', id: `push_disable_${generateUUID()}` },
      xml('disable', { xmlns: NS_PUSH, jid: registration.jid, node: registration.node })
    )

    await this.deps.sendIQ(iq)
    this.deps.emitSDK('connection:push-status', { status: 'available' })
    this.deps.emitSDK('console:event', { message: `Push disabled via ${registration.jid}`, category: 'connection' })
  }
}

/** Reads the node (and secret) from the app server's command result form. */
function parseRegistration(result: Element, appServer: string): PushAppServerRegistration {
  const formEl = result.getChild('command', NS_COMMANDS)?.getChild('x', 'jabber:x:data')
  const form = formEl ? parseDataForm(formEl) : undefined
  const node = form && getFormFieldValue(form, 'node')
  if (!form || !node) {
    throw new Error(`Push app server ${appServer} returned no node`)
  }
  const secret = getFormFieldValue(form, 'secret')
  return {
    jid: getFormFieldValue(form, 'jid') || appServer,
    node,
    ...(secret ? { secret } : {}),
  }
}
