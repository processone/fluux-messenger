/**
 * Type-level enforcement of the two ordering questions (#1173).
 *
 * The `@ts-expect-error` directives below are consumed by `npm run typecheck`,
 * not by vitest: an UNUSED `@ts-expect-error` is itself error TS2578, so each
 * directive fails the build the moment the call it guards starts compiling.
 * That is the whole point of this file. The rule it pins used to live only in a
 * doc comment on `isAhead`, and mutation testing during #1170 twice reduced a
 * positional comparison on this same code path to a key-blind `>=` with the
 * entire suite green. A comment does not survive a refactor that also deletes
 * its controls; a compile error does.
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
  type OrderPosition,
} from './readState'

/** An archive row: its tie-break is always resolvable, so it orders exactly. */
const row: ExactPosition = { timestamp: 1000, tiebreak: makeCacheOrderKey({ id: 'm1' }, 'chat') }
const laterRow: ExactPosition = { timestamp: 1000, tiebreak: makeCacheOrderKey({ id: 'm2' }, 'chat') }

/**
 * What a #1081-migrated pointer's position actually is: a bare millisecond with
 * no provable position inside it. This is the value the whole issue is about.
 */
const keyless: OrderPosition = { timestamp: 1000 }

/**
 * NEVER CALLED. These calls exist only to be typechecked — running them would
 * dereference a tie-break that is absent by construction, which is precisely
 * what the compiler now refuses to let production code do.
 */
function _rejectedAtCompileTime(): void {
  // @ts-expect-error #1173: a keyless position has no tie-break to compare with.
  compareExact(keyless, row)
  // @ts-expect-error #1173: ...and the same holds on the right-hand side.
  compareExact(row, keyless)

  // THE unsafe call the issue is about. `isAfterBoundary` reads a missing
  // tie-break on the BOUNDARY as at-or-after (over-count — safe for counting);
  // reusing it to ask "may the pointer advance?" is exactly what would let a
  // keyed candidate overtake a keyless pointer at the same millisecond. Its
  // `row` parameter is exact, so a pointer position — which may be keyless —
  // cannot be passed as one, and the reduction does not compile.
  // @ts-expect-error #1173: `isAfterBoundary` orders an archive ROW; a pointer is not one.
  isAfterBoundary(keyless, row)
}

describe('the two ordering questions', () => {
  it('keeps the compile-time guard referenced (see _rejectedAtCompileTime)', () => {
    // The guard above is enforced by `npm run typecheck`, not by this runner:
    // each of its three directives fails the build with TS2578 (an unused
    // suppression) the moment the call it guards starts compiling.
    expect(typeof _rejectedAtCompileTime).toBe('function')
  })

  it('still orders two exact positions', () => {
    expect(compareExact(row, laterRow)).toBeLessThan(0)
  })

  it('answers the advance question conservatively for a keyless candidate', () => {
    // `mayAdvanceTo` accepts the keyless side precisely because it must answer
    // for it — and its answer is "no".
    expect(mayAdvanceTo(keyless, row)).toBe(false)
  })

  it('gives the two questions OPPOSITE answers at an equal millisecond', () => {
    // The single fact this whole split exists to keep visible. Same row, same
    // keyless counterpart, same millisecond, deliberately opposite results.
    expect(isAfterBoundary(row, keyless)).toBe(true) // over-count — safe for counting
    expect(mayAdvanceTo(row, keyless)).toBe(false) // never overtake — safe for advancing
  })
})
