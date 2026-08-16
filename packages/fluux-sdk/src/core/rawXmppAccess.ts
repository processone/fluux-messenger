import type { PEPItem } from './e2ee'

// Subpath bundles are built without shared chunks, so this key must resolve to
// the same symbol even when `core` and `xmpp` each contain their own copy.
export const queryPepNodeSymbol = Symbol.for('@fluux/sdk/query-pep-node')

interface RawPepClient {
  [queryPepNodeSymbol](jid: string, node: string, maxItems?: number): Promise<PEPItem[]>
}

export function queryPepNodeFromClient(
  client: object,
  jid: string,
  node: string,
  maxItems?: number,
): Promise<PEPItem[]> {
  const query = (client as RawPepClient)[queryPepNodeSymbol]
  if (typeof query !== 'function') throw new TypeError('Unsupported XMPPClient instance')
  return query.call(client, jid, node, maxItems)
}
