/**
 * Type-level enforcement of the read-position model.
 *
 * The `@ts-expect-error` directives below are consumed by `npm run typecheck`,
 * not by vitest: an UNUSED `@ts-expect-error` is itself error TS2578, so each
 * directive fails the build the moment the call it guards starts compiling.
 * That is the whole point of this file. The rules pinned here used to live only
 * in doc comments, and mutation testing during #1170 twice reduced a positional
 * comparison on this same code path to a key-blind `>=` with the entire suite
 * green. A comment does not survive a refactor that also deletes its controls;
 * a compile error does.
 *
 * Two families are pinned:
 *
 * - **ORDER** (#1173) — the counting question and the advance question have
 *   opposite floor rules, so their comparators must not be interchangeable.
 * - **IDENTITY** — a read position has a local name always and a wire name only
 *   sometimes, so "we cannot address this position yet" is a state every
 *   consumer must handle rather than an absence each one rediscovers.
 *
 * Each directive was counter-verified by widening the thing it guards (making
 * `tiebreak` optional again, putting `archiveId` on both identity variants,
 * dropping `readonly`) and confirming that THAT directive — and only that one —
 * is then reported as unused. A directive that stays consumed under the widening
 * it is supposed to catch is testing something else.
 *
 * Do not "fix" a failure here by widening a signature or deleting a directive.
 * A directive reported as unused means the guard it stands for is gone.
 */
import { describe, it, expect } from 'vitest'
import {
  compareExact,
  isAfterBoundary,
  mayAdvanceTo,
  makeCacheOrderKey,
  type ExactPosition,
  type FloorPosition,
  type PointerOrder,
} from './readState'
import { makeReadPointer, withArchiveId, type PointerIdentity, type ReadPointer } from './readPointer'

/** An archive row: its tie-break is always resolvable, so it orders exactly. */
const row: ExactPosition = { role: 'exact', timestamp: 1000, tiebreak: makeCacheOrderKey({ id: 'm1' }, 'chat') }
const laterRow: ExactPosition = { role: 'exact', timestamp: 1000, tiebreak: makeCacheOrderKey({ id: 'm2' }, 'chat') }

/**
 * What a #1081-migrated pointer's position actually is: a bare millisecond with
 * no provable position inside it. This is the value the whole issue is about.
 */
const floor: FloorPosition = { role: 'floor', timestamp: 1000 }

/** The two identity states, as a consumer would receive them. */
const addressable: PointerIdentity = { state: 'addressable', messageId: 'm1', archiveId: 'archive-1' }
const local: PointerIdentity = { state: 'local', messageId: 'm1' }

/**
 * NEVER CALLED. These declarations exist only to be typechecked — running them
 * would dereference fields that are absent by construction, which is precisely
 * what the compiler now refuses to let production code do.
 */
function _rejectedAtCompileTime(): void {
  // ── ORDER (#1173) ────────────────────────────────────────────────────────
  // @ts-expect-error #1173: a floor position has no tie-break to compare with.
  compareExact(floor, row)
  // @ts-expect-error #1173: ...and the same holds on the right-hand side.
  compareExact(row, floor)

  // THE unsafe call the issue is about. `isAfterBoundary` reads a FLOOR
  // boundary as at-or-after (over-count — safe for counting); reusing it to ask
  // "may the pointer advance?" is exactly what would let an exact candidate
  // overtake a floor pointer at the same millisecond. Its `row` parameter is
  // exact, so a pointer position — which may be a floor — cannot be passed as
  // one, and the reduction does not compile.
  // @ts-expect-error #1173: `isAfterBoundary` orders an archive ROW; a pointer's order is not one.
  isAfterBoundary(floor, row)

  // A floor cannot be silently promoted to an exact position: the tie-break it
  // would need is the thing it does not have.
  // @ts-expect-error a FloorPosition has no tiebreak, so it cannot become exact by spreading.
  const _promoted: ExactPosition = { ...floor, role: 'exact' }
  void _promoted

  // ── IDENTITY ─────────────────────────────────────────────────────────────
  // The degraded state, made unignorable. Reading the wire name without first
  // narrowing on `state` is the mistake the XEP-0490 publisher used to make
  // implicitly, by looking a name up and quietly doing nothing when it failed.
  // No type annotation on purpose: the directive must bite because the PROPERTY
  // does not exist on this variant, not because `string | undefined` fails to
  // assign to `string`. Adding an optional `archiveId` to the 'local' variant
  // frees this directive, which is exactly the widening it is here to catch.
  // @ts-expect-error `archiveId` exists only on the 'addressable' variant.
  void local.archiveId
  // Narrowing is what makes it legal, so the branch has to be written down.
  const _narrowed: string | undefined =
    addressable.state === 'addressable' ? addressable.archiveId : undefined
  void _narrowed

  // THE ANCHOR (#1208's shape, now at the type level). A pointer has exactly ONE
  // name field, and it lives inside `identity`. A second copy beside the order
  // is what used to be able to disagree with it on disk.
  const _twoNames: ReadPointer = {
    order: row,
    identity: local,
    // @ts-expect-error the pointer has exactly ONE name, and it is `identity.messageId`.
    messageId: 'm1',
  }
  void _twoNames

  // Reading the name off the order is likewise not a thing. Unannotated for the
  // same reason as above: this must fail on existence, not on nullability.
  // @ts-expect-error `messageId` is not part of a position; only `identity` names anything.
  void row.messageId

  // A FLOOR order has no `tiebreak` PROPERTY at all — not an optional one — so
  // nothing can read a key off it and nothing can smuggle one in.
  // @ts-expect-error a FloorPosition has no `tiebreak`.
  void floor.tiebreak

  // ── CONVERGENCE CANNOT MOVE THE CURSOR ───────────────────────────────────
  // `order` is readonly on the pointer, and its fields are readonly too, so
  // enrichment cannot reach in and move a position while it renames one.
  const pointer = makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat')
  // @ts-expect-error `order` is readonly: a pointer's position is never rewritten in place.
  pointer.order = floor
  // @ts-expect-error ...and neither is the timestamp inside it.
  pointer.order.timestamp = 60_000
  // @ts-expect-error ...nor the identity, which only `withArchiveId` replaces wholesale.
  pointer.identity = addressable
}

describe('the two ordering questions', () => {
  it('keeps the compile-time guard referenced (see _rejectedAtCompileTime)', () => {
    // The guard above is enforced by `npm run typecheck`, not by this runner:
    // each of its directives fails the build with TS2578 (an unused
    // suppression) the moment the call it guards starts compiling.
    expect(typeof _rejectedAtCompileTime).toBe('function')
  })

  it('still orders two exact positions', () => {
    expect(compareExact(row, laterRow)).toBeLessThan(0)
  })

  it('answers the advance question conservatively for a floor candidate', () => {
    // `mayAdvanceTo` accepts the floor side precisely because it must answer
    // for it — and its answer is "no".
    expect(mayAdvanceTo(floor, row)).toBe(false)
  })

  it('gives the two questions OPPOSITE answers at an equal millisecond', () => {
    // The single fact this whole split exists to keep visible. Same row, same
    // floor counterpart, same millisecond, deliberately opposite results.
    expect(isAfterBoundary(row, floor)).toBe(true) // over-count — safe for counting
    expect(mayAdvanceTo(row, floor)).toBe(false) // never overtake — safe for advancing
  })
})

describe('the identity variant', () => {
  it('mints `addressable` from a message that carries an archive id', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: new Date(1000), stanzaId: 'archive-1' }, 'chat')
    expect(p.identity).toEqual({ state: 'addressable', messageId: 'm1', archiveId: 'archive-1' })
  })

  it('mints `local` from a message that does not — the own-1:1-send resting state', () => {
    const p = makeReadPointer({ id: 'own-1', timestamp: new Date(1000) }, 'chat')
    expect(p.identity).toEqual({ state: 'local', messageId: 'own-1' })
  })

  it('enrichment replaces the identity and carries the order BY REFERENCE', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat')
    const enriched = withArchiveId(p, 'archive-1')
    expect(enriched.identity).toEqual({ state: 'addressable', messageId: 'm1', archiveId: 'archive-1' })
    // The cursor did not move, and could not have: it is the same object.
    expect(enriched.order).toBe(p.order)
  })

  it('never enriches a FLOOR pointer — its name and order already disagree', () => {
    const migrated: ReadPointer = {
      order: { role: 'floor', timestamp: 1000 },
      identity: { state: 'local', messageId: 'm4' },
    }
    expect(withArchiveId(migrated, 'archive-4')).toBe(migrated)
  })

  it('leaves an already-addressable pointer alone, by reference', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: new Date(1000), stanzaId: 'archive-1' }, 'chat')
    expect(withArchiveId(p, 'archive-999')).toBe(p)
  })

  /**
   * §11.1 of the design, stated rather than papered over: the type separates
   * NAME from ORDER and makes the order readonly, so nothing can move a position
   * in place. It does NOT make the order immutable against RECONSTRUCTION — a
   * consumer can still build a fresh pointer with a different timestamp. That
   * stays a review concern; what the model buys is that doing it is visible,
   * because you have to name `order` to do it.
   */
  it('cannot stop a caller REBUILDING a position — only mutating one', () => {
    const p = makeReadPointer({ id: 'm1', timestamp: new Date(1000) }, 'chat')
    const rebuilt: ReadPointer = { order: { role: 'floor', timestamp: 61_000 }, identity: p.identity }
    expect(rebuilt.order.timestamp).toBe(61_000)
  })
})

describe('PointerOrder is a closed discriminated union', () => {
  it('narrows exhaustively on `role`', () => {
    const describeOrder = (o: PointerOrder): string =>
      o.role === 'exact' ? `exact:${o.tiebreak.kind}` : `floor:${o.timestamp}`
    expect(describeOrder(row)).toBe('exact:chat')
    expect(describeOrder(floor)).toBe('floor:1000')
  })
})
