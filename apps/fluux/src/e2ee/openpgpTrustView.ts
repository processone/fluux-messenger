/**
 * The OpenPGP plugin's trust view, for the app: the trust-state verdict, the
 * own-key conflict and the user's decision about each key of a contact.
 *
 * The plugin owns this state and keeps it in its own storage. The app reads
 * it here, for the plugin registered now, and hears of every change. A
 * component reads it through the hooks below; other code subscribes.
 */

import { useSyncExternalStore } from 'react'
import type { BareJID } from '@fluux/sdk'
import type { KeyDecision, OwnKeyConflict, TrustStateVerdict } from '@fluux/openpgp-plugin'

/** What the app reads from the OpenPGP plugin. */
export interface OpenPGPTrustView {
  getTrustState(): TrustStateVerdict
  getOwnKeyConflict(): OwnKeyConflict | null
  getKeyDecisions(peer: BareJID): Readonly<Record<string, KeyDecision>>
  subscribeTrustView(listener: (peers: readonly string[] | null) => void): () => void
}

/** The manager's signal that a contact's keys or their trust changed. */
export interface ConversationSecuritySource {
  onConversationSecurityChanged(listener: (peer: BareJID | null) => void): () => void
}

interface Source {
  view: OpenPGPTrustView
  security: ConversationSecuritySource
}

let current: Source | null = null
const sourceListeners = new Set<() => void>()

/** The plugin just registered, or `null` once it left. */
export function setOpenPGPTrustView(view: OpenPGPTrustView | null, security?: ConversationSecuritySource): void {
  const next = view && security ? { view, security } : null
  if (next?.view === current?.view && next?.security === current?.security) return
  current = next
  for (const listener of [...sourceListeners]) listener()
}

/** The trust view of the plugin registered now, if any. */
export function getOpenPGPTrustView(): OpenPGPTrustView | null {
  return current?.view ?? null
}

/**
 * Run `listener` on every change the source reports, and when the plugin is
 * replaced. `attach` subscribes to one source and returns its unsubscribe.
 */
function follow(listener: () => void, attach: (source: Source, notify: () => void) => Array<() => void>): () => void {
  let detach: Array<() => void> = []
  const reattach = () => {
    detach.forEach((stop) => stop())
    detach = current ? attach(current, listener) : []
  }
  reattach()
  const onSource = () => {
    reattach()
    listener()
  }
  sourceListeners.add(onSource)
  return () => {
    sourceListeners.delete(onSource)
    detach.forEach((stop) => stop())
    detach = []
  }
}

/** Hear of a change of the verdict, the own-key conflict or a key decision. */
export function subscribeOpenPGPTrustView(listener: () => void): () => void {
  return follow(listener, (source, notify) => [source.view.subscribeTrustView(() => notify())])
}

/**
 * Hear of every change that can alter which keys of a contact are used: a
 * trust change as above, or a contact's keys changing on the server.
 */
export function subscribeOpenPGPKeyChanges(listener: () => void): () => void {
  return follow(listener, (source, notify) => [
    source.view.subscribeTrustView(() => notify()),
    source.security.onConversationSecurityChanged(() => notify()),
  ])
}

const NO_DECISIONS: Readonly<Record<string, KeyDecision>> = Object.freeze({})
const NO_VERDICT: TrustStateVerdict = Object.freeze({ status: 'uninitialized' })

/** The user's decision about each key of `peer`, keyed by upper-case fingerprint. */
export function useKeyDecisions(peer: BareJID | null): Readonly<Record<string, KeyDecision>> {
  return useSyncExternalStore(subscribeOpenPGPTrustView, () =>
    peer ? (getOpenPGPTrustView()?.getKeyDecisions(peer) ?? NO_DECISIONS) : NO_DECISIONS,
  )
}

/** The trust-state verdict for this session. */
export function useTrustStateVerdict(): TrustStateVerdict {
  return useSyncExternalStore(subscribeOpenPGPTrustView, () => getOpenPGPTrustView()?.getTrustState() ?? NO_VERDICT)
}

/** The conflict between our key and the one the server publishes, if any. */
export function useOwnKeyConflict(): OwnKeyConflict | null {
  return useSyncExternalStore(subscribeOpenPGPTrustView, () => getOpenPGPTrustView()?.getOwnKeyConflict() ?? null)
}
