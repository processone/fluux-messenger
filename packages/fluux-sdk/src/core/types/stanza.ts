/**
 * The SDK's own element shape, independent of any XML library.
 *
 * @module Core/Types/Stanza
 */

/**
 * Minimal structural form of an XMPP element, JSON-serializable by
 * construction.
 *
 * This is the one element shape the SDK exposes. It exists so that no consumer
 * has to type against ltx: the host converts to and from an `@xmpp/client`
 * Element at the boundary, and the raw type stays on `@fluux/sdk/xmpp`.
 * Being plain data is also what lets the same contract be implemented in
 * TypeScript or fronted by a native runtime (Rust over Tauri, WASM), where an
 * ltx object could not cross the bridge.
 *
 * @category Core
 */
export interface XMLElementData {
  name: string
  attrs: Record<string, string>
  children: Array<XMLElementData | string>
}
