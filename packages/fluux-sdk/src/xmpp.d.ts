declare module '@xmpp/client' {
  export interface Element {
    name: string
    attrs: Record<string, string>
    children: (string | Element)[]
    is(name: string, xmlns?: string): boolean
    getChild(name: string, xmlns?: string): Element | undefined
    getChildren(name: string, xmlns?: string): Element[]
    getChildText(name: string): string | null
    getText(): string
    text(): string
    toString(): string
  }

  /**
   * An entry in the Stream Management outbound queue.
   *
   * `stanza` is nullable because `patchSmAckQueue` (see core/modules/smPatches.ts)
   * injects a `{ stanza: null }` sentinel on empty-queue shifts to survive the
   * unguarded `item.stanza` read in xmpp.js's ackQueue (xmppjs/xmpp.js#1119).
   */
  export interface SmOutboundQueueItem {
    stanza: Element | null
  }

  // XEP-0198 Stream Management
  export interface StreamManagement {
    id: string | null
    inbound: number
    outbound: number
    enabled: boolean
    /** Resume window requested from the server, in seconds (XEP-0198 §3). */
    preferredMaximum: number
    /** Interval (ms) between xmpp.js's built-in `<r/>` keepalives. */
    requestAckInterval: number
    /**
     * Stanzas sent but not yet acked. xmpp.js reassigns this wholesale
     * (e.g. `sm.outbound_q = []` inside resumed()), which is why
     * `patchSmAckQueue` re-patches it through a property setter.
     */
    outbound_q: SmOutboundQueueItem[]
    on(event: 'resumed', handler: () => void): void
    on(event: 'ack', handler: (stanza: Element) => void): void
    on(event: 'fail', handler: (stanza: Element) => void): void
    emit(event: string, ...args: unknown[]): boolean
  }

  /** Context passed to `iqCallee` handlers: the full IQ and its payload child. */
  export interface IqCalleeContext {
    stanza: Element
    element: Element
  }

  /** Outbound IQ requests with response correlation (@xmpp/iq/caller). */
  export interface IqCaller {
    request(stanza: Element, timeout?: number): Promise<Element>
  }

  /** Inbound IQ routing by namespace + payload name (@xmpp/iq/callee). */
  export interface IqCallee {
    get(xmlns: string, name: string, handler: (context: IqCalleeContext) => unknown): void
    set(xmlns: string, name: string, handler: (context: IqCalleeContext) => unknown): void
  }

  /** A FAST token as handed to/from xmpp.js (XEP-0484). */
  export interface FastTokenData {
    mechanism: string
    token: string
    expiry?: string
  }

  /**
   * XEP-0484 FAST module. The default token store is in-memory only, so these
   * three hooks are reassigned to wire up persistence.
   */
  export interface FastModule {
    fetchToken: () => FastTokenData | null | Promise<FastTokenData | null>
    saveToken: (token: FastTokenData) => void
    deleteToken: () => void
  }

  /** Built-in auto-reconnect (@xmpp/reconnect), disabled in favour of our own. */
  export interface ReconnectModule {
    stop(): void
  }

  /** Payload of the 'disconnect' event. */
  export interface DisconnectContext {
    clean: boolean
    reason?: unknown
  }

  /** Events emitted by the client, and the shape of each listener. */
  export interface ClientEventMap {
    online: () => void
    offline: () => void
    error: (err: Error) => void
    stanza: (stanza: Element) => void
    element: (element: Element) => void
    send: (element: Element) => void
    nonza: (nonza: Element) => void
    disconnect: (context: DisconnectContext) => void
  }

  export interface Client {
    on<K extends keyof ClientEventMap>(event: K, handler: ClientEventMap[K]): void
    off<K extends keyof ClientEventMap>(event: K, handler: ClientEventMap[K]): void
    removeListener<K extends keyof ClientEventMap>(event: K, handler: ClientEventMap[K]): void
    /**
     * Register ahead of xmpp.js's own middleware. Used to strip `<sm/>` from
     * `<stream:features>` when SM was already negotiated inline via SASL2.
     */
    prependListener<K extends keyof ClientEventMap>(event: K, handler: ClientEventMap[K]): void
    start(): Promise<void>
    stop(): Promise<void>
    send(element: Element): Promise<void>
    write(data: string): Promise<void>
    streamManagement: StreamManagement
    iqCaller: IqCaller
    iqCallee: IqCallee
    /** Connection lifecycle status, e.g. 'offline' | 'connecting' | 'online'. */
    status: string
    /** Underlying transport socket; null once the socket dies. */
    socket: unknown
    /** Present only when the server offers FAST (XEP-0484). */
    fast?: FastModule
    /** Present unless the reconnect plugin was left out of the client build. */
    reconnect?: ReconnectModule
  }

  export interface ClientOptions {
    service: string
    domain: string
    username?: string
    password?: string
    resource?: string
    lang?: string  // Sets xml:lang attribute on the stream
    /**
     * Timeout (ms) for low-level stream operations: waiting for the server's
     * `<stream:open>` reply, stream close, and raw `sendReceive` exchanges.
     * xmpp.js defaults to 2000ms; we override to give the desktop proxy path
     * room to do DNS + TCP + TLS on cold networks after wake. IQ requests
     * have their own independent 30s default in `@xmpp/iq/caller`.
     */
    timeout?: number
    /** Custom SASL credentials handler. When provided, username/password are ignored. */
    credentials?: (
      authenticate: (creds: Record<string, unknown>, mechanism: string, userAgent?: unknown) => Promise<void>,
      mechanisms: string[],
      fast: { fetch: () => Promise<string | null> } | null,
      entity: { isSecure: () => boolean }
    ) => Promise<void>
  }

  export function client(options: ClientOptions): Client
  export function xml(name: string, attrs?: Record<string, string>, ...children: unknown[]): Element
}

declare module '@xmpp/client/lib/createOnAuthenticate.js' {
  export function getMechanism(options: {
    mechanisms: string[]
    entity: { isSecure: () => boolean }
    credentials: Record<string, unknown>
  }): string
}

declare module '@xmpp/debug' {
  import type { Client } from '@xmpp/client'
  export default function debug(client: Client, enabled: boolean): void
}

