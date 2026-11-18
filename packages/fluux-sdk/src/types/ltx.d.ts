// Type declaration for ltx module (used in xml-parsing tests)
declare module 'ltx' {
  export function parse(xml: string): Element
  /** Deep copy of an element and its children, detached from any parent. */
  export function clone<T>(el: T): T

  export class Element {
    name: string
    attrs: Record<string, string>
    children: (string | Element)[]

    constructor(name: string, attrs?: Record<string, string>)

    getChild(name: string, xmlns?: string): Element | undefined
    getChildren(name: string): Element[]
    getChildText(name: string): string | null
    getText(): string
    text(): string
    is(name: string): boolean
    toString(): string
  }
}
