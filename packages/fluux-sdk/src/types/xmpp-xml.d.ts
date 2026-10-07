declare module '@xmpp/xml' {
  import type { Element } from '@xmpp/client'

  export class Parser {
    write(data: string): void
    on(event: 'error', handler: (error: Error) => void): this
    on(event: 'element', handler: (stanza: Element) => void): this
  }
}
