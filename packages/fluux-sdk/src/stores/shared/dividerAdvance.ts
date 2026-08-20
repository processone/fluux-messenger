import type { NotificationMessage } from './notificationState'
import * as notifState from './notificationState'
import { isAhead, type ReadPointer } from './readPointer'

/**
 * Moving the new-message divider forward on evidence that the reader already read past it.
 *
 * Scrolling this view is navigation: it advances the read pointer but leaves the line where the
 * view opened. A read marker published by ANOTHER of the user's clients is a different kind of
 * fact — it states that those messages were read, elsewhere — so the line follows it rather than
 * standing in front of messages the reader has already seen.
 *
 * Three rules the callers depend on:
 *
 * - never create. A divider that is not parked stays absent, so a marker cannot resurrect one the
 *   reader deliberately cleared.
 * - never clear. A pointer that has caught up is not a reason to retire the landmark; removing it
 *   belongs to read-through scroll, Esc, mark-all-read and deactivation.
 * - never backward, and never on a guess. Both ends must be present in the resident slice: an index
 *   comparison with one end missing cannot order them, and a marker whose target is outside the
 *   window says nothing about where the line should sit.
 */
export function advanceDividerToRemoteRead(
  parkedDivider: string | undefined,
  remoteDivider: string | undefined,
  messages: readonly { id: string }[],
): string | undefined {
  if (parkedDivider === undefined) return undefined
  if (remoteDivider === undefined || remoteDivider === parkedDivider) return parkedDivider

  const parkedIndex = messages.findIndex((message) => message.id === parkedDivider)
  const remoteIndex = messages.findIndex((message) => message.id === remoteDivider)
  if (parkedIndex === -1 || remoteIndex === -1) return parkedDivider

  return remoteIndex > parkedIndex ? remoteDivider : parkedDivider
}

export type RemoteDividerAdvanceResult =
  | { kind: 'advanced'; divider: string }
  | { kind: 'unchanged' }

/**
 * Remembers remote read boundaries that could not be applied to the divider yet.
 *
 * A marker can prove the user read through the newest row this client holds, and then there is no
 * message after it to put the line on. Dropping that proof would leave the line standing in front
 * of messages known to be read for the rest of the visit — the boundary is therefore kept and
 * retried when the slice grows.
 *
 * One boundary per entity, and it only ever moves forward: a later marker that resolves NEARER than
 * one already deferred must not walk the remembered boundary back, or a lagging device would undo
 * what a leading one proved.
 *
 * A deferral is dropped, never re-applied, once the entity holds no divider. Clearing is deliberate
 * — Esc, mark-all-read, sending — and replaying a boundary afterwards would put back a line the
 * reader removed.
 *
 * Callers gate `retry` behind `has`, so an arrival costs nothing while nothing is deferred.
 */
export function createRemoteDividerAdvanceTracker() {
  /** entity id → the furthest remote boundary still waiting for a message to land on. */
  const pending = new Map<string, ReadPointer>()

  function apply<T extends NotificationMessage>(
    id: string,
    parkedDivider: string | undefined,
    markerPointer: ReadPointer,
    messages: T[],
    kind: 'chat' | 'room',
  ): RemoteDividerAdvanceResult {
    // Forward-only: keep whichever of the two boundaries reaches further.
    const remembered = pending.get(id)
    const boundary = remembered && !isAhead(markerPointer, remembered) ? remembered : markerPointer

    if (parkedDivider === undefined) {
      pending.delete(id)
      return { kind: 'unchanged' }
    }

    const remoteDivider = notifState.onActivate(
      {
        unreadCount: 0,
        mentionsCount: 0,
        readPointer: boundary,
        firstNewMessageId: undefined,
      },
      messages,
      kind,
    ).firstNewMessageId

    const parkedIndex = messages.findIndex((message) => message.id === parkedDivider)
    const remoteIndex = remoteDivider === undefined
      ? -1
      : messages.findIndex((message) => message.id === remoteDivider)

    // Nothing to land on, or an end that cannot be ordered inside this slice. Hold the proof
    // rather than spend it: `retry` gets another chance once the slice changes.
    if (remoteDivider === undefined || parkedIndex === -1 || remoteIndex === -1) {
      pending.set(id, boundary)
      return { kind: 'unchanged' }
    }

    pending.delete(id)
    const divider = advanceDividerToRemoteRead(parkedDivider, remoteDivider, messages)
    return divider !== parkedDivider && divider !== undefined
      ? { kind: 'advanced', divider }
      : { kind: 'unchanged' }
  }

  return {
    apply,
    retry<T extends NotificationMessage>(
      id: string,
      parkedDivider: string | undefined,
      messages: T[],
      kind: 'chat' | 'room',
    ): RemoteDividerAdvanceResult {
      const markerPointer = pending.get(id)
      return markerPointer === undefined
        ? { kind: 'unchanged' }
        : apply(id, parkedDivider, markerPointer, messages, kind)
    },
    has(id: string): boolean {
      return pending.has(id)
    },
    clear(id: string): void {
      pending.delete(id)
    },
    reset(): void {
      pending.clear()
    },
  }
}
