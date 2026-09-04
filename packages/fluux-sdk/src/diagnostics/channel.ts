/**
 * The SDK's diagnostic channel: one subscription, one payload union.
 *
 * Every diagnostic occurrence the SDK reports to an outside observer arrives here,
 * discriminated by `kind`. A new occurrence seam becomes a member of
 * {@link DiagnosticEvent} and a publisher calling {@link publishDiagnostic}; it does
 * not become another exported function, and it does not restate the two rules below.
 *
 * Both rules live in the channel's publication boundary, which is the only place
 * in the SDK that hands a payload to a subscriber:
 *
 * - **Nothing is built when nobody subscribes to that kind.** A publisher supplies
 *   the kind, a builder and its source, never a finished payload, so a build with no
 *   listener for that kind pays the call and constant-time registry reads.
 *   `bench/outboundSeam.bench.ts` gates that cost on the one hot path the channel
 *   carries.
 * - **No two subscribers share a payload.** The builder runs once, then the
 *   kind-specific isolator snapshots the event for each subscriber.
 *
 * A handler that throws is contained. Publication happens on the send path and on
 * merge completion, and a diagnostic must never break the operation it observes.
 *
 * Module scope, not per client: the stores this channel reports from are module
 * singletons, so a diagnostic is a property of the process, not of a connection.
 * The handler registry is shared through `globalThis` because the published package
 * compiles this module into several entry points.
 *
 * Only occurrences are event kinds here. `readStateGeneration` stays a plain reader
 * because a generation is a VALUE, not an occurrence: it is only meaningful read in
 * the same turn as the pointer it explains, and a generation learned later than that
 * pointer turns an account switch into a phantom pointer regression. An event form
 * would have to carry the pointer and its generation in ONE payload, which is a
 * change to every pointer write site rather than to this channel.
 *
 * @module Diagnostics/Channel
 */
import type { Element } from '@xmpp/client'
import { dataToElement, elementToData } from '../core/e2ee/stanzaAdapter'

/**
 * An application-layer stanza handed to the transport.
 *
 * Reports messages, presence and IQ requests, including the id assigned before
 * hand-off. Connection-level sends — the keepalive ping, the Stream Management
 * `<r/>` nonza — bypass the application layer and are invisible here by
 * construction.
 *
 * `stanza` is an independent deep snapshot, so a subscriber can neither alter the
 * wire form nor reach what another subscriber received.
 */
export interface ApplicationStanzaOutDiagnostic {
  kind: 'application-stanza-out'
  stanza: Element
}

export type ArchiveMergeOutcome = 'durable' | 'partial' | 'failed'

/**
 * How a merge disposed of the rows it was given. Every returned row gets exactly
 * one disposition, and they balance:
 *
 * ```
 * returned === retained + deduplicated + patched + intentionallyUnstored + persistenceFailed
 * ```
 *
 * `stores/shared/archiveMergeDiagnostics.ts` holds the arithmetic that fills them.
 */
export interface ArchiveMergeCounts {
  outcome: ArchiveMergeOutcome
  returned: number
  retained: number
  deduplicated: number
  patched: number
  intentionallyUnstored: number
  persistenceFailed: number
}

export interface ArchiveMergeReport extends ArchiveMergeCounts {
  entityKind: 'chat' | 'room'
  /**
   * The conversation id or room JID, raw.
   *
   * A diagnostic consumer that needs a privacy-safe identity derives it at its own
   * boundary; the SDK has no business minting one.
   */
  entityId: string
  direction: 'backward' | 'forward'
  /** Whether the walk reported the archive exhausted in that direction. */
  complete: boolean
}

/**
 * What an archive merge did with every row a MAM walk returned.
 *
 * Published once the durable outcome is KNOWN, not when the merge is applied: a
 * report written at merge time would claim a retention that can still fail.
 *
 * Retention is decided inside the store, downstream of the typed history event, so
 * it is observable from nowhere else.
 */
export interface ArchiveMergeDiagnostic {
  kind: 'archive-merge'
  report: ArchiveMergeReport
}

export type RecountEntityKind = 'chat' | 'room'

/**
 * The distinct ways an unread recount can end without committing a count.
 *
 * `recomputeUnreadForConversation` and `recomputeUnreadForRoom` are a chain of about
 * twenty guards, most of which defer rather than count. Every one is correct in
 * isolation — an uncertain count is worse than a stale one — but from outside the
 * store they are indistinguishable: the badge simply keeps its old value, and nothing
 * says which guard stood down. That gap is issue #1211, where a MUC badge stays up
 * while its room is open and clears only on switching away.
 *
 * A closed union so a new guard cannot be added silently: adding one means naming it
 * here, and a name is what makes the verdict readable.
 */
export type RecountDeferralReason =
  /** Skipped because the entity is active and the caller did not opt in. */
  | 'active-skipped'
  /** No metadata for the entity — nothing to correct. */
  | 'no-meta'
  /** No read position was ever established, and a bare zero cannot be trusted. */
  | 'pointerless-defer'
  /** A remote XEP-0490 position is still being resolved. */
  | 'pending-remote-displayed'
  /** Neither a read pointer nor a history floor to count from. */
  | 'no-floor'
  /** History has not caught up, so any count would be derived from partial history. */
  | 'history-not-caught-up'
  /** Cache epoch or storage scope moved under this recount. */
  | 'context-changed'
  /** No coverage record for the entity, so the archive bottom is unknown. */
  | 'coverage-missing'
  /** A coverage record exists but its bottom no longer resolves in the archive. */
  | 'coverage-unresolvable'
  /** Coverage does not reach back to the floor, so the count would under-report. */
  | 'coverage-short-of-floor'
  /** The archive count itself was unavailable — an IndexedDB error. */
  | 'cache-unavailable'
  /** Another recount for the same entity started while this one was awaiting. */
  | 'recount-superseded'
  /**
   * Message inputs changed while this recount was awaiting, so its result describes
   * a state that no longer exists.
   *
   * `addMessage` bumps this version on every arrival, so a snapshot computed before
   * live traffic cannot commit after that traffic changes its inputs.
   */
  | 'input-version-changed'
  /** The read pointer moved while the recount was in flight. */
  | 'pointer-changed'

/**
 * What one recount invocation concluded.
 *
 * `counted` means the derivation reached the end of the gate chain against an
 * unmoved snapshot, so `count` IS the badge's value from here — including when the
 * badge already held it and nothing was written. `previousCount` is what the badge
 * displayed in that same `set()` turn, which is the one thing no outside observer can
 * sample: reading the badge separately would pair two numbers that were never true at
 * the same instant.
 *
 * `deferred` names the guard that stood down. The recount would have been guessing,
 * so this is not evidence of a bug — it is evidence about WHY a badge kept its value.
 */
export type UnreadRecountVerdict =
  | { status: 'counted'; count: number; previousCount: number }
  | { status: 'deferred'; reason: RecountDeferralReason }

/**
 * The verdict of one unread recount, published by the recount itself.
 *
 * Exactly one per `recomputeUnreadFor*` invocation. The recount is the only thing
 * that derives an unread count from the archive, so having it report is what removes
 * the alternative: a consumer subscribing to metadata maps and reconstructing WHEN
 * the answer might have changed, which is never complete.
 *
 * None of the recount's prelude side effects are reported, because each already has a
 * public face in the vocabulary above: the latest-wins version bump surfaces as
 * `recount-superseded`, the coverage invalidation as `coverage-unresolvable`, and the
 * transient-overlay prune is folded into `count` (the overlay is read after it is
 * pruned). Publishing the counters themselves would put the store's race guards in
 * the public payload.
 *
 * `entityId` is raw, like every other identifier on this channel: a consumer that
 * needs a privacy-safe identity derives it at its own boundary.
 */
export interface UnreadRecountDiagnostic {
  kind: 'unread-recount'
  entityKind: RecountEntityKind
  entityId: string
  verdict: UnreadRecountVerdict
}

/**
 * The badge was cleared without moving the read pointer.
 *
 * `markAsRead` clears the counts and advances the pointer to the newest message when
 * the reader is demonstrably at the live edge. Above the live edge it cannot know
 * WHICH message the reader reached, so it clears the counts only and leaves the
 * pointer where it is (#1076) — leaving the tab does this on every navigation away.
 *
 * That transition can leave the badge at a value the read pointer does not imply, so
 * it is reported explicitly. It is not evidence of an anomaly by itself, nor does it
 * establish continuity between recounts: the archive and pointer can move through
 * other supported paths between two verdicts.
 *
 * `previousCount` is the badge value that was cleared. There is no `count`: the
 * transition writes zero by definition.
 */
export interface UnreadClearedDiagnostic {
  kind: 'unread-cleared'
  entityKind: RecountEntityKind
  entityId: string
  previousCount: number
}

export type DiagnosticEvent =
  | ApplicationStanzaOutDiagnostic
  | ArchiveMergeDiagnostic
  | UnreadRecountDiagnostic
  | UnreadClearedDiagnostic

export type DiagnosticHandler = (event: DiagnosticEvent) => void
export type DiagnosticKind = DiagnosticEvent['kind']
export interface DiagnosticSubscriptionOptions {
  kinds?: readonly DiagnosticKind[]
}

type DiagnosticOfKind<K extends DiagnosticKind> = Extract<DiagnosticEvent, { kind: K }>
type DiagnosticIsolators = {
  [K in DiagnosticKind]: (event: DiagnosticOfKind<K>) => DiagnosticOfKind<K>
}

const diagnosticIsolators: DiagnosticIsolators = {
  'application-stanza-out': (event) => ({
    kind: event.kind,
    stanza: dataToElement(elementToData(event.stanza)),
  }),
  'archive-merge': (event) => ({
    kind: event.kind,
    report: { ...event.report },
  }),
  'unread-recount': (event) => ({
    kind: event.kind,
    entityKind: event.entityKind,
    entityId: event.entityId,
    verdict: { ...event.verdict },
  }),
  'unread-cleared': (event) => ({
    kind: event.kind,
    entityKind: event.entityKind,
    entityId: event.entityId,
    previousCount: event.previousCount,
  }),
}

const diagnosticHandlersKey = Symbol.for('fluux.sdk.diagnostics.handlers')
const diagnosticsGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
type DiagnosticRegistry = {
  catchAll: Set<DiagnosticHandler>
  byKind: { [K in DiagnosticKind]: Set<DiagnosticHandler> }
}

function createDiagnosticRegistry(): DiagnosticRegistry {
  return {
    catchAll: new Set(),
    byKind: {
      'application-stanza-out': new Set(),
      'archive-merge': new Set(),
      'unread-recount': new Set(),
      'unread-cleared': new Set(),
    },
  }
}

const registry = (diagnosticsGlobal[diagnosticHandlersKey] ??=
  createDiagnosticRegistry()) as DiagnosticRegistry

function isolateDiagnostic(event: DiagnosticEvent): DiagnosticEvent {
  switch (event.kind) {
    case 'application-stanza-out':
      return diagnosticIsolators[event.kind](event)
    case 'archive-merge':
      return diagnosticIsolators[event.kind](event)
    case 'unread-recount':
      return diagnosticIsolators[event.kind](event)
    case 'unread-cleared':
      return diagnosticIsolators[event.kind](event)
  }
}

/**
 * Observe every diagnostic the SDK publishes.
 *
 * @param handler - invoked with its own payload for each event; switch on
 * `event.kind`.
 * @param options - omit for every kind, or list only the kinds this handler needs.
 * @returns an unsubscribe function.
 *
 * @example
 * ```typescript
 * const unsubscribe = subscribeDiagnostics((event) => {
 *   if (event.kind === 'application-stanza-out') console.log('Sent:', event.stanza.toString())
 * })
 * ```
 */
export function subscribeDiagnostics(
  handler: DiagnosticHandler,
  options?: DiagnosticSubscriptionOptions,
): () => void {
  const kinds = options?.kinds === undefined ? undefined : [...new Set(options.kinds)]
  if (kinds === undefined) {
    registry.catchAll.add(handler)
  } else {
    for (const kind of kinds) registry.byKind[kind].add(handler)
  }
  return () => {
    if (kinds === undefined) {
      registry.catchAll.delete(handler)
    } else {
      for (const kind of kinds) registry.byKind[kind].delete(handler)
    }
  }
}

/**
 * Build the event once and hand every subscriber its own isolated payload.
 *
 * Reached only with at least one subscriber: both entry points below answer that
 * question first, so nothing here runs for an unsubscribed build.
 */
function deliverDiagnostic<K extends DiagnosticKind, S>(
  kind: K,
  build: (source: S) => DiagnosticOfKind<K>,
  source: S,
): void {
  let event: DiagnosticOfKind<K>
  try {
    event = build(source)
  } catch (err) {
    console.warn('[diagnostics] publisher threw:', err)
    return
  }

  for (const handlers of [registry.catchAll, registry.byKind[kind]]) {
    for (const handler of handlers) {
      try {
        handler(isolateDiagnostic(event))
      } catch (err) {
        console.warn('[diagnostics] subscriber threw:', err)
      }
    }
  }
}

/**
 * The channel's publication boundary, for a source that is already in hand.
 *
 * `kind`, `build` and `source` are separate parameters rather than one thunk because the
 * outbound stanza path calls this for every stanza the application sends: a closure
 * built at that call site would put an allocation on the hot path even with nothing
 * subscribed. The kind must be known before the builder runs so a listener for an
 * unrelated diagnostic cannot make this payload exist. A literal kind plus a
 * module-level builder keeps that check allocation-free, while the type requires
 * the builder to return the declared kind.
 *
 * The subscriber check is repeated here rather than delegated so that an
 * unsubscribed send returns from THIS frame: `bench/outboundSeam.bench.ts` measures
 * the difference, and one more call on the way to the same answer is visible in it.
 *
 * @internal Publishers are SDK-side. A consumer subscribes; it does not publish.
 */
export function publishDiagnostic<K extends DiagnosticKind, S>(
  kind: K,
  build: (source: S) => DiagnosticOfKind<NoInfer<K>>,
  source: S,
): void {
  if (registry.catchAll.size === 0 && registry.byKind[kind].size === 0) return
  deliverDiagnostic(kind, build, source)
}

/**
 * The same boundary for a source only known after an await.
 *
 * `produce` runs only when something is listening, so a publisher whose payload
 * costs work to obtain — awaiting a write gate, then counting — pays none of it for
 * an unsubscribed build, and states that rule nowhere itself.
 *
 * @internal Publishers are SDK-side. A consumer subscribes; it does not publish.
 */
export function publishDeferredDiagnostic<K extends DiagnosticKind, S>(
  kind: K,
  build: (source: S) => DiagnosticOfKind<NoInfer<K>>,
  produce: () => Promise<S>,
): void {
  if (registry.catchAll.size === 0 && registry.byKind[kind].size === 0) return
  try {
    void produce()
      .then((source) => deliverDiagnostic(kind, build, source))
      .catch((err) => {
        console.warn('[diagnostics] publisher threw:', err)
      })
  } catch (err) {
    console.warn('[diagnostics] publisher threw:', err)
  }
}

/** Test-only: drop every subscriber. */
export function resetDiagnosticsForTesting(): void {
  registry.catchAll.clear()
  for (const handlers of Object.values(registry.byKind)) handlers.clear()
}
