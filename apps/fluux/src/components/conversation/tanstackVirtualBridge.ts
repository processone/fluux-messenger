/**
 * The only file that reaches into @tanstack/virtual-core's private state.
 *
 * The bridge isolates command and scroll bookkeeping, commit timing and resize batches behind typed
 * accessors. Each accessor is guarded; the contract test checks the installed library so a missing
 * or reshaped member does not silently disable a behavior. The version pins in package.json and
 * renovate.json make that check part of a deliberate upgrade.
 */

// virtual-core's record of a compensation write the browser clamped: the position it meant, in
// layout coordinates, and the element max (plus held offset) the write stopped at.
export type ClampedWrite = { target: number; maxAtWrite: number }
// The private gesture tracker of @tanstack/virtual-core 3.19.5+ (absent before, so every use is guarded).
export type IosGestureLike = { end?: () => void; tail?: () => 'tap' | 'fling' | null }
// Private command identity: virtual-core keeps this object when a queued command starts writing.
export type ScrollCommandLike = { phase?: string }

type LibraryInternals = {
  scrollState?: ScrollCommandLike | null
  _holdOffset?: number
  _willUpdate?: () => unknown
  _iosGesture?: IosGestureLike
  _clampedAdjustment?: unknown
  pendingWrite?: { target: number } | null
  applyScrollAdjustment?: (delta: number) => boolean
  _resizeBatch?: object | null
  _clampedBy?: (target: number) => unknown
  _canWriteScroll?: () => boolean
  _awaitingCommandReadBack?: () => boolean
}

const internals = (instance: object) => instance as LibraryInternals

// Marks a virtualizer whose commit-time update has been wrapped, so it is wrapped once.
const COMMIT_TRACKED = Symbol('commitTracked')

/** The command the library holds for a queued or landing navigation write (`scrollState`). */
export function libraryCommand(instance: object): ScrollCommandLike | null {
  return internals(instance).scrollState ?? null
}

/** The correction the library holds on top of the element's position (`_holdOffset`), 0 when none. */
export function heldOffset(instance: object): number {
  return internals(instance)._holdOffset ?? 0
}

/** The iOS gesture tracker (`_iosGesture`), absent before virtual-core 3.19.5. */
export function iosGesture(instance: object): IosGestureLike | undefined {
  return internals(instance)._iosGesture
}

/** Whether an iOS fling is still running. */
export function hasPendingFling(instance: object): boolean {
  return iosGesture(instance)?.tail?.() === 'fling'
}

/** Whether a measurement write may go out now (`_canWriteScroll`); true when the library has no such test. */
export function canWriteScroll(instance: object): boolean {
  return internals(instance)._canWriteScroll?.() !== false
}

/** Whether a command's written position has not been read back yet (`_awaitingCommandReadBack`). */
export function awaitingCommandReadBack(instance: object): boolean {
  return Boolean(internals(instance)._awaitingCommandReadBack?.())
}

/** Whether the library offers its own correction for a row-size shift (`applyScrollAdjustment`). */
export function hasLibraryAdjustment(instance: object): boolean {
  return typeof internals(instance).applyScrollAdjustment === 'function'
}

/** Applies the library's own correction for a row-size shift; false when it has none or does not move. */
export function applyLibraryAdjustment(instance: object, delta: number): boolean {
  const apply = internals(instance).applyScrollAdjustment
  return typeof apply === 'function' ? apply.call(instance, delta) : false
}

/**
 * The library's clamped-write record as it stands now (`_clampedAdjustment`). A write past the
 * element's max is clamped until the spacer grows, and virtual-core keeps the meant position to retry
 * once it has. The next compensation overwrites that record with its own just before it writes, so a
 * writer takes it before the library resizes the row. A library that renames it leaves each correction
 * on the element's position, as before.
 */
export function clampedWrite(instance: object): ClampedWrite | null {
  const pending = internals(instance)._clampedAdjustment as ClampedWrite | null | undefined
  return pending && typeof pending.target === 'number' && typeof pending.maxAtWrite === 'number'
    ? { target: pending.target, maxAtWrite: pending.maxAtWrite } : null
}

/**
 * Points virtual-core's bookkeeping for a compensation write at the position actually written:
 * `target` is in layout coordinates (the library adds its held offset to the element position).
 * Its write record (`pendingWrite`), which the read-back is matched against, and its clamp recovery
 * (`_clampedAdjustment`, from `_clampedBy`) were computed from the offset it decided on, so a rebased
 * write that kept the old ones would be read back as foreign and lose the part a not yet grown spacer
 * clamps away. A library that renames them leaves the write correct and only the bookkeeping as it was.
 */
export function retargetLibraryWrite(instance: object, layoutOffset: number, delta: number): void {
  const lib = internals(instance)
  const target = layoutOffset + delta
  if (lib.pendingWrite) lib.pendingWrite.target = target
  if (typeof lib._clampedBy === 'function') lib._clampedAdjustment = lib._clampedBy(target)
}

/**
 * Runs `onCommit(true)` while virtual-core runs its commit-time update (`_willUpdate`, in a layout
 * effect: a hold flush or a clamp retry), and `onCommit(false)` after. React cannot render
 * synchronously inside its commit, so a read-back reported from there asks for no synchronous render.
 * Wrapped once per virtualizer; a library that renames the method leaves those reports asking as the
 * library would.
 */
export function trackCommitUpdate(instance: object, onCommit: (committing: boolean) => void): void {
  const commit = instance as LibraryInternals & { [COMMIT_TRACKED]?: true }
  if (typeof commit._willUpdate !== 'function' || commit[COMMIT_TRACKED]) return
  const willUpdate = commit._willUpdate
  commit._willUpdate = () => {
    onCommit(true)
    try { return willUpdate.call(instance) } finally { onCommit(false) }
  }
  commit[COMMIT_TRACKED] = true
}

/** Whether virtual-core is still measuring entries, before its final batch notification. */
export function isMeasuringResizeBatch(instance: object): boolean {
  return Boolean(internals(instance)._resizeBatch)
}

/** The private names this file relies on, each with how a live instance must present it. */
export const LIBRARY_PRIVATE_NAMES = {
  scrollState: 'property',
  _holdOffset: 'number',
  _willUpdate: 'function',
  _resizeBatch: 'property',
  _iosGesture: 'object',
  _clampedAdjustment: 'property',
  pendingWrite: 'property',
  applyScrollAdjustment: 'function',
  _clampedBy: 'function',
  _canWriteScroll: 'function',
  _awaitingCommandReadBack: 'function',
} as const

/** The names of LIBRARY_PRIVATE_NAMES a live virtualizer does not present in the expected shape. */
export function missingLibraryNames(instance: object): string[] {
  return (Object.keys(LIBRARY_PRIVATE_NAMES) as (keyof typeof LIBRARY_PRIVATE_NAMES)[]).filter(name => {
    const shape = LIBRARY_PRIVATE_NAMES[name]
    if (!(name in instance)) return true
    const value = (instance as Record<string, unknown>)[name]
    return shape === 'property' ? false : typeof value !== shape || (shape === 'object' && value === null)
  })
}
