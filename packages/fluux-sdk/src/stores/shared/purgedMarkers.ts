/**
 * XEP-0490 markers the archive has PROVEN it no longer holds, and markers the
 * node has superseded.
 *
 * A remote read marker the loaded slice cannot order is stashed as
 * `pendingRemoteDisplayedStanzaId`, and every later merge retries it. That is
 * correct while the marker is merely deep. It is a permanent lock once the
 * server has purged the message it names: the retry can never succeed, the
 * unread recount defers on it forever, and `publishDecision` answers `retry`
 * forever — so the entity stops publishing its read position at all.
 *
 * The catch-up walk already derives the proof (a backward page reporting
 * `complete` with the marker still pending means the archive start was reached
 * without finding it). This module is where that proof is kept, so the discard
 * it authorises cannot be undone by the next thing that re-applies the same
 * dead marker.
 *
 * A superseded marker is weaker than a purged one: a later marker the resolver
 * could order has replaced it on the node (see `supersededPendingMarker`). It
 * stays stashed and retried; the record only stops the recount deferring on it.
 *
 * SESSION-SCOPED, deliberately. The purged marker is still on the MDS node until
 * our replacement publish lands, so the `online` seed re-applies it on every
 * reconnect; without this record the entity would re-stash and re-lock before
 * the publish went out. It is not persisted: "the server no longer has this id"
 * is cheap to re-derive and must not outlive a wipe of local state.
 *
 * These are NEGATIVE caches and nothing more. Each records that one id no
 * longer holds the entity; it never asserts a read POSITION, and nothing here
 * can move a read pointer. A record for an id that is not the stash is inert.
 *
 * Scoped by `{accountScope, kind, entityId}` — same shape and rationale as
 * `viewportEvidence.ts` and `transientUnread.ts`: a bare entity id can collide
 * across accounts sharing the same room/chat id.
 *
 * @module Stores/Shared/PurgedMarkers
 */

export interface PurgedMarkerKey {
  kind: 'chat' | 'room'
  entityId: string
  accountScope: string
}

// U+0000 separator: account scopes/kinds/entity ids cannot contain it, so joins never collide.
const SEP = String.fromCharCode(0)

function keyString(key: PurgedMarkerKey): string {
  return `${key.accountScope}${SEP}${key.kind}${SEP}${key.entityId}`
}

/**
 * entity key → the one stanza-id recorded for it.
 *
 * One id per entity: a newer marker supersedes an older one, and only the
 * marker currently stashed can ever be proven absent or superseded, so there is
 * never a second live candidate to remember.
 */
function createMarkerRecord() {
  const records = new Map<string, string>()
  return {
    note(key: PurgedMarkerKey, stanzaId: string): void {
      records.set(keyString(key), stanzaId)
    },
    has(key: PurgedMarkerKey, stanzaId: string): boolean {
      return records.get(keyString(key)) === stanzaId
    },
    clear(accountScope: string): void {
      const prefix = `${accountScope}${SEP}`
      for (const key of records.keys()) {
        if (key.startsWith(prefix)) records.delete(key)
      }
    },
    reset(): void {
      records.clear()
    },
  }
}

const purged = createMarkerRecord()
const superseded = createMarkerRecord()

/** Record that `stanzaId` is not in this entity's archive. */
export function notePurgedMarker(key: PurgedMarkerKey, stanzaId: string): void {
  purged.note(key, stanzaId)
}

/** Has `stanzaId` been proven absent from this entity's archive this session? */
export function isMarkerPurged(key: PurgedMarkerKey, stanzaId: string): boolean {
  return purged.has(key, stanzaId)
}

/** Record that the node replaced the stashed `stanzaId` with a marker the resolver ordered. */
export function noteSupersededMarker(key: PurgedMarkerKey, stanzaId: string): void {
  superseded.note(key, stanzaId)
}

/** Has the stashed `stanzaId` been superseded on the node this session? */
export function isMarkerSuperseded(key: PurgedMarkerKey, stanzaId: string): boolean {
  return superseded.has(key, stanzaId)
}

/** Forget one account's records, purged and superseded alike — account switch, mirroring `clearViewportEvidence`. */
export function clearPurgedMarkers(accountScope: string): void {
  purged.clear(accountScope)
  superseded.clear(accountScope)
}

/** Test-only. */
export function _resetPurgedMarkersForTesting(): void {
  purged.reset()
  superseded.reset()
}
