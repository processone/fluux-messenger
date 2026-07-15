// Ambient module shims mirroring @fluux/sdk's own (fluux-sdk/src/xmpp.d.ts and
// src/types/ltx.d.ts). `@xmpp/client` and `ltx` ship no type declarations, so
// every package that touches XML declares them. We depend on the SAME versions
// the SDK does (`@xmpp/client` + `ltx`), giving the project a single @xmpp
// lineage — the plugin never introduces a second @xmpp package or version.
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
    /** Append a child and return the parent (ltx `Element.append`). */
    append(child: Element | string): Element
    toString(): string
  }
  export function xml(name: string, attrs?: Record<string, string>, ...children: unknown[]): Element
}

declare module 'ltx' {
  export function parse(xml: string): import('@xmpp/client').Element
}
