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
 * - **Nothing is built when nobody subscribes.** A publisher supplies a builder and
 *   its source, never a finished payload, so an unsubscribed build pays the call and
 *   one `Set` read. `bench/outboundSeam.bench.ts` gates that cost on the one hot
 *   path the channel carries.
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
 * Only occurrences are event kinds here. `chatUnreadDiagnostic` and
 * `roomUnreadDiagnostic` remain asynchronous questions over one validated snapshot
 * until the recount can report either its committed count or why it declined.
 * `chatReadStateGeneration` and `roomReadStateGeneration` remain values read in the
 * same turn as the pointers they explain; publishing them separately would let an
 * account switch look like a pointer regression. Their epochs also change outside
 * store updates, so event publication would first require ordering guarantees at
 * every bump site. Those store changes belong to the next diagnostic-surface slice.
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

export type DiagnosticEvent = ApplicationStanzaOutDiagnostic | ArchiveMergeDiagnostic

export type DiagnosticHandler = (event: DiagnosticEvent) => void

type DiagnosticKind = DiagnosticEvent['kind']
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
}

const diagnosticHandlersKey = Symbol.for('fluux.sdk.diagnostics.handlers')
const diagnosticsGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
const handlers = (diagnosticsGlobal[diagnosticHandlersKey] ??=
  new Set<DiagnosticHandler>()) as Set<DiagnosticHandler>

function isolateDiagnostic(event: DiagnosticEvent): DiagnosticEvent {
  switch (event.kind) {
    case 'application-stanza-out':
      return diagnosticIsolators[event.kind](event)
    case 'archive-merge':
      return diagnosticIsolators[event.kind](event)
  }
}

/**
 * Observe every diagnostic the SDK publishes.
 *
 * @param handler - invoked with its own payload for each event; switch on
 * `event.kind`.
 * @returns an unsubscribe function.
 *
 * @example
 * ```typescript
 * const unsubscribe = subscribeDiagnostics((event) => {
 *   if (event.kind === 'application-stanza-out') console.log('Sent:', event.stanza.toString())
 * })
 * ```
 */
export function subscribeDiagnostics(handler: DiagnosticHandler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/**
 * Build the event once and hand every subscriber its own isolated payload.
 *
 * Reached only with at least one subscriber: both entry points below answer that
 * question first, so nothing here runs for an unsubscribed build.
 */
function deliverDiagnostic<S>(build: (source: S) => DiagnosticEvent, source: S): void {
  let event: DiagnosticEvent
  try {
    event = build(source)
  } catch (err) {
    console.warn('[diagnostics] publisher threw:', err)
    return
  }

  for (const handler of handlers) {
    try {
      handler(isolateDiagnostic(event))
    } catch (err) {
      console.warn('[diagnostics] subscriber threw:', err)
    }
  }
}

/**
 * The channel's publication boundary, for a source that is already in hand.
 *
 * `build` and `source` are two parameters rather than one thunk because the
 * outbound stanza path calls this for every stanza the application sends: a closure
 * built at that call site would put an allocation on the hot path even with nothing
 * subscribed. A module-level builder taking the source keeps the unsubscribed cost
 * to the call and the `Set` read.
 *
 * The subscriber check is repeated here rather than delegated so that an
 * unsubscribed send returns from THIS frame: `bench/outboundSeam.bench.ts` measures
 * the difference, and one more call on the way to the same answer is visible in it.
 *
 * @internal Publishers are SDK-side. A consumer subscribes; it does not publish.
 */
export function publishDiagnostic<S>(build: (source: S) => DiagnosticEvent, source: S): void {
  if (handlers.size === 0) return
  deliverDiagnostic(build, source)
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
export function publishDeferredDiagnostic<S>(
  build: (source: S) => DiagnosticEvent,
  produce: () => Promise<S>
): void {
  if (handlers.size === 0) return
  try {
    void produce()
      .then((source) => deliverDiagnostic(build, source))
      .catch((err) => {
        console.warn('[diagnostics] publisher threw:', err)
      })
  } catch (err) {
    console.warn('[diagnostics] publisher threw:', err)
  }
}

/** Test-only: drop every subscriber. */
export function resetDiagnosticsForTesting(): void {
  handlers.clear()
}
