/**
 * SDK-owned, generation-scoped viewport evidence.
 *
 * `onMessageReceived` (`notificationState.ts`) used to treat `isActive &&
 * windowVisible` as "the user saw this" and advance the read pointer on
 * arrival — so a conversation that is open and focused but SCROLLED UP in
 * history wrongly marked new messages read. This module supplies the missing
 * ingredient: whether the viewport is genuinely at the live edge, scoped to
 * the CURRENT activation so a stale/delayed report from a previous activation
 * (or a previous entity) can never be mistaken for current truth.
 *
 * Generation ownership — exactly one owner. The SDK activation path
 * (`chatStore.setActiveConversation` / `roomStore.setActiveRoom`) calls
 * {@link beginViewportGeneration} synchronously and is its SOLE caller. The
 * app/view layer never begins a generation — it only reads the current one
 * via {@link currentViewportGeneration} and reports against it via
 * {@link reportViewport}. If the view also began generations, its own call
 * would immediately invalidate the token the SDK just created, discarding the
 * first measurement after every switch.
 *
 * `unknown` is the initial state for every fresh generation and means "not at
 * the edge" — missing / stale / unknown evidence must NEVER authorize a
 * pointer advance (the safe, forward-compatible default; see
 * `EntityContext.viewportAtLiveEdge` and `onMessageReceived`'s
 * `userSeesMessage` gate).
 *
 * Scoped by `{accountScope, kind, entityId}` — same shape and rationale as
 * `transientUnread.ts`'s `ScopeKey`: a bare entity id can collide across
 * accounts sharing the same room/chat id.
 *
 * @module Stores/Shared/ViewportEvidence
 */

export type ViewportEvidence = 'unknown' | 'at-edge' | 'away'

export interface EvidenceKey {
  kind: 'chat' | 'room'
  entityId: string
  accountScope: string
}

interface EntityEvidence {
  generation: number
  evidence: ViewportEvidence
}

// U+0000 separator: account scopes/kinds/entity ids cannot contain it, so joins never collide.
const SEP = String.fromCharCode(0)

const entities = new Map<string, EntityEvidence>()

function keyString(key: EvidenceKey): string {
  return `${key.accountScope}${SEP}${key.kind}${SEP}${key.entityId}`
}

/**
 * Start a fresh activation generation for `key`, resetting its evidence to
 * `unknown`. Synchronous and idempotent-per-call (each call bumps the
 * generation by one, even for a re-activation of the SAME entity — see the
 * module doc's "same-entity reactivation" scenario). Returns the new
 * generation number.
 *
 * SOLE CALLER: the SDK's activation path (`setActiveConversation` /
 * `setActiveRoom`). Never call this from the view layer.
 */
export function beginViewportGeneration(key: EvidenceKey): number {
  const k = keyString(key)
  const prev = entities.get(k)
  const generation = (prev?.generation ?? 0) + 1
  entities.set(k, { generation, evidence: 'unknown' })
  return generation
}

/**
 * The current generation token for `key` — the value the view must echo back
 * through {@link reportViewport}. `0` for an entity that has never been
 * activated (never began a generation); `reportViewport` rejects a report
 * carrying `0` just like any other stale/mismatched generation, since there is
 * no current entry to match it against.
 */
export function currentViewportGeneration(key: EvidenceKey): number {
  return entities.get(keyString(key))?.generation ?? 0
}

/**
 * Report measured viewport state for `key`, tagged with the generation the
 * caller read via {@link currentViewportGeneration} at the time it captured
 * the callback (NOT re-read inside the callback — see `ChatView`/`RoomView`'s
 * doc on why that would defeat the whole mechanism). A report whose
 * generation does not match the CURRENT generation — because the entity was
 * never activated, or was re-activated since — is silently ignored: this is
 * the whole point, it is what makes a delayed callback from a previous
 * activation harmless.
 */
export function reportViewport(key: EvidenceKey, generation: number, evidence: 'at-edge' | 'away'): void {
  const k = keyString(key)
  const current = entities.get(k)
  if (!current || generation !== current.generation) return
  if (current.evidence === evidence) return
  entities.set(k, { generation: current.generation, evidence })
}

/**
 * The entity's current viewport evidence. `unknown` for a never-activated
 * entity, a freshly-activated one awaiting its first measurement, or one
 * whose only reports were rejected as stale.
 */
export function currentViewportEvidence(key: EvidenceKey): ViewportEvidence {
  return entities.get(keyString(key))?.evidence ?? 'unknown'
}

/** Drop every entity's evidence for an account. Account teardown / scope switch ONLY. */
export function clearViewportEvidence(accountScope: string): void {
  const prefix = `${accountScope}${SEP}`
  for (const k of entities.keys()) {
    if (k.startsWith(prefix)) entities.delete(k)
  }
}

/**
 * Test-only: drop every entity's evidence, across every account. This
 * module's state is a plain top-level `Map` — not part of any Zustand store —
 * so resetting a store's state between tests does not touch it.
 */
export function _clearAllViewportEvidenceForTesting(): void {
  entities.clear()
}
