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

  // XEP-0198 Stream Management
  export interface StreamManagement {
    id: string | null
    inbound: number
    outbound: number
    enabled: boolean
    on(event: 'resumed', handler: () => void): void
    on(event: 'ack', handler: (stanza: Element) => void): void
    on(event: 'fail', handler: (stanza: Element) => void): void
  }

  export interface Client {
    on(event: 'online', handler: () => void): void
    on(event: 'offline', handler: () => void): void
    on(event: 'error', handler: (err: Error) => void): void
    on(event: 'stanza', handler: (stanza: Element) => void): void
    on(event: 'element', handler: (element: Element) => void): void
    on(event: 'send', handler: (element: Element) => void): void
    start(): Promise<void>
    stop(): Promise<void>
    send(element: Element): Promise<void>
    write(data: string): Promise<void>
    streamManagement: StreamManagement
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

