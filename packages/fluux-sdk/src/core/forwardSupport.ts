/**
 * Per-device discovery of standalone forwarded-copy support.
 *
 * A forward is sent as a structured XEP-0297 copy only when every known recipient
 * device positively advertises {@link NS_FORWARD_COPY}. Discovery asks each device
 * itself (XEP-0030 with the XEP-0115 node), never the server, the account or the client
 * brand. A device without capabilities, a failed or slow answer, or no device at all
 * means "not supported", so the sender falls back to the quoted copy.
 */

import { xml, type Element } from '@xmpp/client'
import { NS_DISCO_INFO, NS_FORWARD_COPY } from './namespaces'
import { generateUUID } from '../utils/uuid'

const DISCOVERY_TIMEOUT_MS = 4000

export class ForwardSupport {
  /** XEP-0115 node#ver last announced by each full JID. */
  private readonly announced = new Map<string, { node: string; ver: string }>()
  /** Moves whenever a device's announcement changes, so an answer given before the move is not trusted. */
  private generation = 0
  /** Answers per full JID and ver, so a device is asked once per announced version. */
  private readonly answers = new Map<string, Promise<boolean>>()

  constructor(private readonly sendIQ: (iq: Element, timeoutMs?: number) => Promise<Element>) {}

  /** Record the capabilities a device announced in its presence. */
  note(fullJid: string, caps: Element | undefined): void {
    const node = caps?.attrs?.node
    const ver = caps?.attrs?.ver
    if (!node || !ver) {
      this.forget(fullJid)
      return
    }
    const previous = this.announced.get(fullJid)
    if (previous?.node === node && previous.ver === ver) return
    this.forget(fullJid)
    this.announced.set(fullJid, { node, ver })
    this.generation++
  }

  /** A device went offline: its announcement and answers are stale. */
  forget(fullJid: string): void {
    this.generation++
    this.announced.delete(fullJid)
    for (const key of this.answers.keys()) if (key.startsWith(`${fullJid}\0`)) this.answers.delete(key)
  }

  clear(): void {
    this.generation++
    this.announced.clear()
    this.answers.clear()
  }

  /**
   * True only when there is at least one device and every one of them advertises the feature.
   * The device list is read again once discovery returns: a device that joined, left or changed its
   * announcement meanwhile makes the answer stale, so it is refused.
   */
  async everyDeviceSupports(bareJid: string, currentResources: () => readonly string[]): Promise<boolean> {
    const resources = [...currentResources()]
    if (resources.length === 0 || resources.some(resource => !resource)) return false
    const generation = this.generation
    try {
      const results = await Promise.all(resources.map(resource => this.deviceSupports(`${bareJid}/${resource}`)))
      if (!results.every(Boolean) || generation !== this.generation) return false
      const now = new Set(currentResources())
      return now.size === resources.length && resources.every(resource => now.has(resource))
    } catch {
      return false
    }
  }

  private deviceSupports(fullJid: string): Promise<boolean> {
    const caps = this.announced.get(fullJid)
    if (!caps) return Promise.resolve(false)
    const key = `${fullJid}\0${caps.node}#${caps.ver}`
    let answer = this.answers.get(key)
    if (!answer) {
      answer = this.discover(fullJid, `${caps.node}#${caps.ver}`).catch(() => {
        // A failed discovery is not cached: the next forward asks again.
        this.answers.delete(key)
        return false
      })
      this.answers.set(key, answer)
    }
    return answer
  }

  private async discover(fullJid: string, node: string): Promise<boolean> {
    const iq = xml('iq', { type: 'get', to: fullJid, id: `disco_info_${generateUUID()}` },
      xml('query', { xmlns: NS_DISCO_INFO, node }))
    const result = await this.sendIQ(iq, DISCOVERY_TIMEOUT_MS)
    const query = result.getChild('query', NS_DISCO_INFO)
    if (!query) return false
    return query.getChildren('feature').some((feature: Element) => feature.attrs.var === NS_FORWARD_COPY)
  }
}
