import type { PEPItem, PEPPublishOptions } from './e2ee'

// Subpath bundles are built without shared chunks, so this key must resolve to
// the same symbol even when `core` and `xmpp` each contain their own copy.
export const queryPepNodeSymbol = Symbol.for('@fluux/sdk/query-pep-node')

export const publishPepNodeSymbol = Symbol.for('@fluux/sdk/publish-pep-node')

interface RawPepClient {
  [queryPepNodeSymbol](jid: string, node: string, maxItems?: number): Promise<PEPItem[]>
  [publishPepNodeSymbol](node: string, item: PEPItem, options?: PEPPublishOptions): Promise<void>
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

export function publishPepNodeFromClient(
  client: object,
  node: string,
  item: PEPItem,
  options?: PEPPublishOptions,
): Promise<void> {
  const publish = (client as RawPepClient)[publishPepNodeSymbol]
  if (typeof publish !== 'function') throw new TypeError('Unsupported XMPPClient instance')
  return publish.call(client, node, item, options)
}
