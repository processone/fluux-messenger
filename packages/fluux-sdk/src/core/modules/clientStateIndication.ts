/**
 * XEP-0352 Client State Indication.
 *
 * Tells the server whether the user is looking at the client. While the
 * client is inactive, the server may hold back or collapse traffic that is not
 * urgent (presence, chat states, PEP). Messages are still delivered at once.
 *
 * @module Core/ClientStateIndication
 */
import { xml, Element } from '@xmpp/client'
import type { ClientState } from '../types'

export const NS_CSI = 'urn:xmpp:csi:0'
const NS_STREAMS = 'http://etherx.jabber.org/streams'
const NS_BIND = 'urn:ietf:params:xml:ns:xmpp-bind'
const NS_SASL2 = 'urn:xmpp:sasl:2'
const NS_BIND2 = 'urn:xmpp:bind:0'

/**
 * Whether stream features advertise CSI, or `undefined` when they do not say.
 *
 * The server advertises it either among the features after authentication, or
 * as a Bind 2 inline feature among the SASL2 features before it. Features that
 * offer resource binding without CSI come after authentication, so they rule it
 * out; any other features element leaves the question open.
 */
export function csiAdvertised(features: Element): boolean | undefined {
  if (!features.is('features', NS_STREAMS)) return undefined
  if (features.getChild('csi', NS_CSI)) return true
  const bind2Inline = features
    .getChild('authentication', NS_SASL2)
    ?.getChild('inline')
    ?.getChild('bind', NS_BIND2)
    ?.getChild('inline')
  if (bind2Inline?.getChildren('feature').some((f) => f.attrs.var === NS_CSI)) return true
  if (features.getChild('bind', NS_BIND)) return false
  return undefined
}

/**
 * Keeps the server's view of the client state in line with the app's.
 *
 * The app's state survives reconnects. A new session starts active on the
 * server, so only an inactive state is sent then; a resumed session gets the
 * current state again, whatever it was when the stream dropped.
 */
export class ClientStateIndication {
  private state: ClientState = 'active'
  private supported = false
  private serverState: ClientState = 'active'

  constructor(private readonly send: (element: Element) => Promise<void> | undefined) {}

  get current(): ClientState {
    return this.state
  }

  /** A new stream is opening: its features decide whether CSI is available. */
  resetStream(): void {
    this.supported = false
    this.serverState = 'active'
  }

  observeFeatures(features: Element): void {
    const advertised = csiAdvertised(features)
    if (advertised !== undefined) this.supported = advertised
  }

  sessionStarted(resumed: boolean): void {
    if (!resumed) this.serverState = 'active'
    if (!this.supported) return
    if (resumed || this.state !== this.serverState) void this.transmit()
  }

  /** Records the app's state and sends it when the session can carry it. */
  set(state: ClientState, online: boolean): void {
    this.state = state
    if (online && this.supported && state !== this.serverState) void this.transmit()
  }

  private async transmit(): Promise<void> {
    // Recorded before the send completes, so a change made meanwhile is
    // compared against what is already on its way.
    this.serverState = this.state
    try {
      await this.send(xml(this.state, { xmlns: NS_CSI }))
    } catch {
      // The stream is going away; the next session sends the state again.
    }
  }
}
