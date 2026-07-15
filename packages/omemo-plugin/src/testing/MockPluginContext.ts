// In-memory `PluginContext` test host for `@fluux/omemo-plugin`.
//
// `createMockPluginContext` wires a plugin against a shared `MockNetwork`
// so two contexts (e.g. Alice + Bob) can exchange PEP publications the way
// they would over a real server's pubsub service. This is a test utility
// only — it is never shipped as part of the plugin's runtime surface.
import type {
  PluginContext,
  PEPItem,
  PluginStorage,
  E2EESubscription as Subscription,
  SecurityContextUpdate,
  XMLElementData,
} from '@fluux/sdk'

/**
 * Shared in-memory PEP network. Nodes and subscriptions are keyed by
 * `"${jid} ${node}"` so a subscription registered for a peer's node fires
 * when that peer (and only that peer) publishes to it.
 */
export interface MockNetwork {
  nodes: Map<string, PEPItem[]>
  subs: Map<string, Array<(item: PEPItem) => void>>
}

export function newMockNetwork(): MockNetwork {
  return { nodes: new Map(), subs: new Map() }
}

function pepKey(jid: string, node: string): string {
  return `${jid} ${node}`
}

function memPluginStorage(): PluginStorage {
  const store = new Map<string, Uint8Array>()
  return {
    async get(key) {
      return store.get(key) ?? null
    },
    async put(key, value) {
      store.set(key, value)
    },
    async delete(key) {
      store.delete(key)
    },
    async list(prefix) {
      return [...store.keys()].filter((key) => key.startsWith(prefix))
    },
  }
}

/**
 * Creates an in-memory `PluginContext` for `jid`. Pass another context's
 * `net` as `shared` so both contexts publish/query/subscribe against the
 * same PEP network — the shape a real deployment would see over the wire.
 */
export function createMockPluginContext(
  jid: string,
  shared?: MockNetwork,
): { ctx: PluginContext; net: MockNetwork; updates: SecurityContextUpdate[] } {
  const net = shared ?? newMockNetwork()
  const updates: SecurityContextUpdate[] = []

  const ctx: PluginContext = {
    storage: memPluginStorage(),
    account: { jid },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    reportSecurityContextUpdate(update) {
      updates.push(update)
    },
    notifyKeyUnlocked() {},
    xmpp: {
      async sendStanza() {},
      async queryDisco() {
        return { features: [], identities: [] }
      },
      async publishPEP(node, item) {
        const key = pepKey(jid, node)
        net.nodes.set(key, [item])
        for (const cb of net.subs.get(key) ?? []) cb(item)
      },
      async retractPEP(node) {
        net.nodes.delete(pepKey(jid, node))
      },
      async deletePEP(node) {
        net.nodes.delete(pepKey(jid, node))
      },
      async queryPEP(peer, node) {
        return net.nodes.get(pepKey(peer, node)) ?? []
      },
      subscribePEP(peer, node, cb): Subscription {
        const key = pepKey(peer, node)
        const listeners = net.subs.get(key) ?? []
        listeners.push(cb)
        net.subs.set(key, listeners)
        return {
          unsubscribe() {
            const current = net.subs.get(key)
            if (!current) return
            const idx = current.indexOf(cb)
            if (idx >= 0) current.splice(idx, 1)
          },
        }
      },
    },
  }

  return { ctx, net, updates }
}

/**
 * Injects a foreign jid's PEP item directly into `net`, bypassing
 * `publishPEP`. Used by interop tests that need to seed a peer's bundle or
 * device list without standing up a full `createMockPluginContext` for
 * them (e.g. fixture data captured from a reference implementation).
 */
export function seedPeer(net: MockNetwork, jid: string, node: string, payload: XMLElementData): void {
  net.nodes.set(pepKey(jid, node), [{ id: 'current', payload }])
}
