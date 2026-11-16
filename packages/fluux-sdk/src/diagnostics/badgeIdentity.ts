import { generateUUID } from '../utils/uuid'

// Module entry points share one weak map. No diagnostic field is added to a
// message, persisted by a cache, or confused with the product's row identity.
const registryKey = Symbol.for('fluux.sdk.badge-diagnostic-occurrences')
const registry = globalThis as typeof globalThis & Record<symbol, WeakMap<object, string> | undefined>
const occurrences = registry[registryKey] ??= new WeakMap<object, string>()

/** Read or propagate a key already minted by a subscribed diagnostic publisher. */
export function badgeMessageKey(message: object, stanza?: object): string | undefined {
  const key = occurrences.get(message) ?? (stanza && occurrences.get(stanza))
  if (key) {
    occurrences.set(message, key)
    if (stanza) occurrences.set(stanza, key)
  }
  return key
}

/** Call only inside a publishDiagnostic builder: an occurrence needs no wire identity. */
export function createBadgeMessageKey(source: object): string {
  let key = occurrences.get(source)
  if (!key) {
    key = generateUUID()
    occurrences.set(source, key)
  }
  return key
}
