import { useCallback, useEffect, useRef, useState } from 'react'
import { defaultRangeExtractor, elementScroll, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { MessageVirtualizer, ScrollWrite, ScrollWriteOutcome, ScrollWriteOwner } from './messageVirtualizer'

// Frames with neither a scroll event nor an offset change before we declare scrolling settled and
// stop polling (~100ms at 60fps — close to @tanstack's default 150ms isScrollingResetDelay).
const OFFSET_POLL_IDLE_FRAMES = 6
const ENTRY_OVERSCAN = 2
const STEADY_OVERSCAN = 12

function useEntryOverscan(hasRows: boolean): number {
  const [overscan, setOverscan] = useState(ENTRY_OVERSCAN)
  useEffect(() => {
    if (!hasRows || overscan === STEADY_OVERSCAN) return
    // Visible rows and a small margin measure immediately. The larger offscreen buffer can
    // wait for a paint, keeping its React commit and geometry reads out of the entry task.
    let secondFrame: number | undefined
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setOverscan(STEADY_OVERSCAN))
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame)
    }
  }, [hasRows, overscan])
  return overscan
}

// Marks a virtualizer whose commit-time update the adapter already tracks.
const COMMIT_TRACKED = Symbol('commitTracked')

/** Whether the offset observer is following a scroll in progress. See observeElementOffsetWithRaf. */
export interface ScrollActivity { active: boolean }

/**
 * Drop-in replacement for @tanstack/react-virtual's `observeElementOffset` that re-windows from a
 * requestAnimationFrame poll of `scrollTop`, not only from the element's `scroll` event.
 *
 * WHY: the default observer updates the virtualizer's offset (and thus the mounted window) ONLY
 * when the scroll element fires a `scroll` event. WebKit — the Tauri desktop webview — coalesces
 * or withholds `scroll` events during INERTIAL ("kinetic") momentum scrolling: the layer scrolls
 * on the compositor while JS sees no event. With the default observer the mounted window then
 * freezes mid-fling, so the same rows render as the user scrolls (the "looping images" report).
 * Chromium fires `scroll` promptly during inertia, so it never shows the bug — and the headless
 * preview/Playwright harness can't reproduce momentum at all.
 *
 * HOW: keep the `scroll` listener (so the Chromium path is unchanged) but, once a gesture starts
 * (scroll / wheel / touch), poll `scrollTop` every frame and push each change into the virtualizer.
 * The poll stops after OFFSET_POLL_IDLE_FRAMES with neither a scroll event nor an offset change, so
 * it runs only during an active scroll. A scroll event counts as motion even when the poll then
 * reads the offset that event already reported: otherwise a steady stream of events would read as
 * settled every few frames, clearing the virtualizer's isScrolling and direction mid-scroll. It is
 * strictly READ-ONLY (never writes scrollTop) so it cannot feed back into the scroll-correction
 * loops. Same `(instance, cb) => cleanup` contract as the @tanstack default.
 *
 * `activity.active` tells the caller whether a scroll is in progress: from a scroll event, marked
 * before the element's other scroll listeners run, or an observed offset change, until the poll
 * settles. While it is set, this observer reports the positions itself.
 */
export function observeElementOffsetWithRaf(
  instance: { scrollElement: HTMLElement | null },
  cb: (offset: number, isScrolling: boolean) => void,
  activity: ScrollActivity = { active: false },
): void | (() => void) {
  const el = instance.scrollElement
  if (!el) return

  let rafId: number | null = null
  let lastOffset = el.scrollTop
  let idleFrames = 0

  const tick = () => {
    const offset = el.scrollTop
    if (offset !== lastOffset) {
      lastOffset = offset
      idleFrames = 0
      activity.active = true
      cb(offset, true)
    } else if (++idleFrames >= OFFSET_POLL_IDLE_FRAMES) {
      rafId = null
      activity.active = false
      cb(offset, false) // scrolling settled — resume measurement adjustments
      return
    }
    rafId = requestAnimationFrame(tick)
  }

  const startPolling = () => {
    if (rafId === null) {
      idleFrames = 0
      rafId = requestAnimationFrame(tick)
    }
  }

  // Capture phase: runs before the app's own scroll handler on this element, so a reader takeover
  // that handler triggers already sees the scroll in progress.
  const onScrollStarted = () => {
    activity.active = true
    idleFrames = 0
    startPolling()
  }

  const onScroll = () => {
    lastOffset = el.scrollTop
    cb(lastOffset, true)
    onScrollStarted()
  }

  el.addEventListener('scroll', onScrollStarted, { capture: true, passive: true })
  el.addEventListener('scroll', onScroll, { passive: true })
  // Momentum initiators: WebKit may suppress the `scroll` event during the inertial phase, so
  // begin polling the moment the gesture starts rather than waiting for a `scroll` that won't come.
  el.addEventListener('wheel', startPolling, { passive: true })
  el.addEventListener('touchmove', startPolling, { passive: true })

  return () => {
    el.removeEventListener('scroll', onScrollStarted, { capture: true })
    el.removeEventListener('scroll', onScroll)
    el.removeEventListener('wheel', startPolling)
    el.removeEventListener('touchmove', startPolling)
    if (rafId !== null) cancelAnimationFrame(rafId)
    activity.active = false
  }
}

/**
 * Points virtual-core's bookkeeping for a compensation write at the position actually written:
 * `target` is in layout coordinates (the library adds its held offset to the element position).
 * Its write record, which the read-back is matched against, and its clamp recovery were computed
 * from the offset it decided on, so a rebased write that kept the old ones would be read back as
 * foreign and lose the part a not yet grown spacer clamps away. Both are private, so a library
 * that renames them leaves the write correct and only the bookkeeping as it was.
 */
function retargetLibraryWrite(instance: object, layoutOffset: number, delta: number) {
  const lib = instance as {
    pendingWrite?: { target: number } | null
    _clampedAdjustment?: unknown
    _clampedBy?: (target: number) => unknown
  }
  const target = layoutOffset + delta
  if (lib.pendingWrite) lib.pendingWrite.target = target
  if (typeof lib._clampedBy === 'function') lib._clampedAdjustment = lib._clampedBy(target)
}

function settleWrite(record: WriteRecord, outcome: ScrollWriteOutcome): ScrollWriteOutcome {
  record.outcome ??= outcome
  return record.outcome
}

interface Args {
  /** Only the stable `key` per row is needed — the adapter is agnostic to item kind
   *  (date/message/header/footer all window uniformly). The caller renders by kind. */
  items: readonly { key: string }[]
  indexById: Map<string, number>
  scrollRef: React.RefObject<HTMLElement | null>
  /** Flat constant (px) or a per-index function. Default: 64.
   *  See refreshEstimates for applying changed metrics to unmeasured rows. */
  estimateSize?: number | ((index: number) => number)
  sampleEstimateMetrics?: () => void
  /**
   * Pre-seeded measured heights from a previous mount of this conversation.
   * Keys are item keys (= message ids). Passed as @tanstack's `initialMeasurementsCache` so
   * resident rows start at their real height rather than snapping from estimates on re-entry.
   */
  initialMeasurements?: ReadonlyMap<string, number>
  /**
   * Called after each row measurement with its key and measured size (px > 0 only).
   * Used to write back to the persistent height cache.
   */
  onMeasured?: (key: string, size: number) => void
}

/**
 * MessageVirtualizer backed by @tanstack/react-virtual (v3). Spike-gated: if prepend
 * anchoring can't be made pixel-accurate, this is swapped for a custom impl
 * behind the same interface, leaving the scroll-hook integration untouched.
 *
 * `getItemKey = items[i].key` (the message id) binds the measurement cache to the message,
 * not the index, so it survives MAM prepend (which shifts every index).
 */
// The private gesture tracker of @tanstack/virtual-core 3.19.5+ (absent before, so every use is guarded).
type IosGestureLike = { end?: () => void; tail?: () => 'tap' | 'fling' | null }
// Private command identity: virtual-core keeps this object when a queued command starts writing.
type ScrollCommandLike = { phase?: string }
// The private library correction an estimate refresh reuses, and the state its resize path checks first.
type CorrectionInternals = {
  scrollState?: ScrollCommandLike | null
  _holdOffset?: number
  _awaitingCommandReadBack?: () => boolean
  _canWriteScroll?: () => boolean
  applyScrollAdjustment?: (delta: number) => boolean
}
type ItemKey = ReturnType<Virtualizer<HTMLElement, Element>['options']['getItemKey']>
// What the next measurement write corrects, judged when it was decided: the row virtual-core is
// about to resize, or an estimate refresh whose shift at the reader is already measured.
type Correction =
  | { kind: 'resize'; index: number; key: ItemKey; start: number; end: number; first: boolean }
  | { kind: 'estimates' }
// One navigation write, from the call that decided it to the outcome its receipt reads. `command`
// is set while the library holds it for a fling; `outcome` once it has been written or refused.
interface WriteRecord {
  id: number
  owner: ScrollWriteOwner | undefined
  command: ScrollCommandLike | null
  // The scroller the write was issued against; a different one by the time it lands is `detached`.
  scroller: Element | null
  // The reader-takeover check scrollToOffset already ran before releasing a gesture.
  prechecked: boolean
  outcome: ScrollWriteOutcome | null
}

export function useTanstackMessageVirtualizer({
  items, indexById, scrollRef, estimateSize = 64, sampleEstimateMetrics, initialMeasurements, onMeasured,
}: Args): MessageVirtualizer {
  const overscan = useEntryOverscan(items.length > 0)
  const [retainedId, setRetainedId] = useState<string | null>(null)
  const retainedIdRef = useRef<string | null>(null)
  const writeObserverRef = useRef<Parameters<NonNullable<MessageVirtualizer['setScrollWriteObserver']>>[0]>(undefined)
  // The write in progress (null outside a navigation call) and the one the library holds.
  const currentWriteRef = useRef<WriteRecord | null>(null)
  const queuedWriteRef = useRef<WriteRecord | null>(null)
  const writeIdRef = useRef(0)
  // Bumped whenever the reader takes the pixels: any destination decided earlier is void.
  const generationRef = useRef(0)
  const correctionRef = useRef<Correction | null>(null)
  const setScrollWriteObserver = useCallback<NonNullable<MessageVirtualizer['setScrollWriteObserver']>>(
    observer => { writeObserverRef.current = observer }, [],
  )
  // Which rows a resize compensates: the library's fold rule, including shrink during backward
  // motion, none while the caller owns the pixels, or rows before a held anchor. See holdAnchor.
  const adjustmentEnabledRef = useRef(true)
  const heldAnchorRef = useRef<string | null>(null)
  const indexByIdRef = useRef(indexById)
  indexByIdRef.current = indexById
  const heldAnchorIndex = useCallback(() =>
    heldAnchorRef.current === null ? undefined : indexByIdRef.current.get(heldAnchorRef.current), [])
  const shouldAdjustOnResize = useCallback<NonNullable<
    Virtualizer<HTMLElement, Element>['shouldAdjustScrollPositionOnItemSizeChange']
  >>((item, delta, instance) => {
    if (!adjustmentEnabledRef.current) return false
    // A held anchor compensates every preceding row, including rows in the viewport. An
    // anchor absent from the current rows compensates nothing until the holder lets go.
    const anchorIndex = heldAnchorIndex()
    if (heldAnchorRef.current !== null) return anchorIndex !== undefined && item.index < anchorIndex
    const offset = instance.scrollOffset ?? 0
    // Mirror virtual-core's default fold/direction rule except for backward shrink; review this
    // override when upgrading the library. The lazy layout can still carry an earlier size.
    const end = item.start + (instance.itemSizeCache.get(item.key) ?? item.size)
    return instance.itemSizeCache.has(item.key)
      ? end <= offset && (delta < 0 || instance.scrollDirection !== 'backward')
      : item.start < offset
  }, [heldAnchorIndex])
  const retainedIndex = retainedId === null ? undefined : indexById.get(retainedId)
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range)
    if (retainedIndex !== undefined && !indexes.includes(retainedIndex)) {
      indexes.push(retainedIndex)
      indexes.sort((a, b) => a - b)
    }
    return indexes
  }, [retainedIndex])
  // Keep row estimates independent of the mounted-window average: structural rows can skew it
  // and collapse the content height. The caller owns estimation; see useRowMetrics for calibration.
  // @tanstack hands its offset callback to `observeElementOffset` on (re)mount. At the accepted
  // writer we push the element's actual post-write position with isScrolling=false, so rows mount
  // without waiting for a native event; a write the library makes on its own while the reader
  // scrolls reports it as motion instead (reportWritten). Queued navigation keeps its command
  // identity until that first write; the caller returning does not turn it into layout
  // reconciliation. The non-sync callback uses plain rerender() rather than a synthetic scroll
  // event's flushSync, which is illegal during a MAM-prepend restore useLayoutEffect.
  const offsetCbRef = useRef<((offset: number, isScrolling: boolean) => void) | null>(null)
  const scrollActivityRef = useRef<ScrollActivity>({ active: false })
  // Set while virtual-core runs its commit-time update. See the tracking after useVirtualizer.
  const committingRef = useRef(false)
  // Reports the element's position as motion while the reader scrolls. With keepDirection it is
  // the read-back of our own write: a correction moves the content, not the reader, so the reader's
  // direction is kept rather than taken from the correction's sign. Inside React's commit the
  // report asks for no synchronous render, as virtual-core asks for none there itself.
  const reportMotion = (instance: Virtualizer<HTMLElement, Element>, offset: number, keepDirection: boolean) => {
    const report = offsetCbRef.current
    if (!report) return
    const direction = instance.scrollDirection
    const options = instance.options
    const onChange = options.onChange
    if (committingRef.current && onChange) options.onChange = inst => onChange(inst, false)
    try {
      report(offset, true)
    } finally {
      options.onChange = onChange
      if (keepDirection) instance.scrollDirection = direction
    }
  }
  // Publishes the position our own write left the element at: at rest, or as motion while the
  // reader scrolls, so the write does not clear the library's isScrolling and direction mid-scroll.
  const reportWritten = (instance: Virtualizer<HTMLElement, Element>, offset: number) => {
    if (scrollActivityRef.current.active) reportMotion(instance, offset, true)
    else offsetCbRef.current?.(offset, false)
  }
  const observeOffset = useCallback(
    (instance: Virtualizer<HTMLElement, Element>, cb: (offset: number, isScrolling: boolean) => void) => {
      offsetCbRef.current = cb
      const activity: ScrollActivity = { active: false }
      scrollActivityRef.current = activity
      const cleanup = observeElementOffsetWithRaf(instance, cb, activity)
      return () => {
        offsetCbRef.current = null
        cleanup?.()
      }
    },
    [],
  )

  // The stable estimateSize callback reads the latest caller value; cache invalidation is
  // controlled by getItemKey below and refreshEstimates.
  const estimateRef = useRef(estimateSize)
  estimateRef.current = estimateSize
  const sampleEstimateMetricsRef = useRef(sampleEstimateMetrics)
  sampleEstimateMetricsRef.current = sampleEstimateMetrics
  const samplePendingRef = useRef(false)
  const estimateFn = useCallback(
    (index: number) => {
      const e = estimateRef.current
      return typeof e === 'function' ? e(index) : e
    },
    [],
  )

  // Build @tanstack's `initialMeasurementsCache` once at mount from the caller-supplied map.
  // VirtualItem shape: { key, index, start, end, size, lane }
  // start/end/lane can be 0 — @tanstack recomputes layout offsets from scratch; size is all that
  // matters for the seed. Only build if initialMeasurements is non-empty (additive; empty cache
  // leaves behavior byte-identical to the pre-feature state).
  // Use a ref so it is evaluated once (at mount) without needing eslint-disable on empty deps.
  const initialMeasurementsCacheRef = useRef<Array<{ key: string | number; index: number; start: number; end: number; size: number; lane: number }> | undefined>(undefined)
  if (initialMeasurementsCacheRef.current === undefined && initialMeasurements && initialMeasurements.size > 0) {
    const result: Array<{ key: string | number; index: number; start: number; end: number; size: number; lane: number }> = []
    for (let i = 0; i < items.length; i++) {
      const key = items[i].key
      const size = initialMeasurements.get(key)
      if (size !== undefined && size > 0) {
        result.push({ key, index: i, start: 0, end: 0, size, lane: 0 })
      }
    }
    if (result.length > 0) initialMeasurementsCacheRef.current = result
  }

  // Keep a stable ref to onMeasured so the measureElement wrapper never changes identity.
  const onMeasuredRef = useRef(onMeasured)
  onMeasuredRef.current = onMeasured

  // virtual-core memoises its measurements on getItemKey identity: a new identity re-runs
  // estimateSize for every unmeasured row. The key function therefore changes only with `items`,
  // or when refreshEstimates deliberately asks for a re-derivation.
  const itemKeyRef = useRef<{ items: Args['items']; getItemKey: (index: number) => string } | null>(null)
  const nextItemKey = (current: Args['items']) => ({ items: current, getItemKey: (index: number) => current[index].key })
  if (itemKeyRef.current?.items !== items) itemKeyRef.current = nextItemKey(items)
  const getItemKey = itemKeyRef.current.getItemKey

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateFn,
    getItemKey,
    overscan,
    rangeExtractor,
    scrollToFn: (offset, options, instance) => {
      const command = (instance as unknown as { scrollState?: ScrollCommandLike | null }).scrollState
      const queuedRecord = queuedWriteRef.current
      const queued = queuedRecord?.command ?? null
      // _writeAwaitingCommand changes the same command's phase before its first write. A hold
      // flush that precedes it is still queued, and a row-size adjustment is not that command.
      const queuedWrite = queued !== null && command === queued
        && command.phase !== 'queued' && options.adjustments === undefined
      if (queuedWrite || (queued !== null && command !== queued)) queuedWriteRef.current = null
      const source = currentWriteRef.current !== null || queuedWrite ? 'navigation'
        : options.adjustments !== undefined ? 'measurement' : 'reconcile'
      // The write's authority: the destination generation, scroller and row set it was decided under.
      // The observer below can hand the pixels to the reader (cancelPendingScroll) before we write.
      const generation = generationRef.current
      // Taken before the observer: its takeover can invalidate this write.
      const correction = source === 'measurement' ? correctionRef.current : null
      if (source === 'measurement') correctionRef.current = null
      const scroller = instance.scrollElement
      const rows = itemKeyRef.current?.items
      const observer = writeObserverRef.current
      const record = source !== 'navigation' ? null : queuedWrite ? queuedRecord : currentWriteRef.current
      // A write whose request is no longer the active one is never written, held or not. The
      // library would otherwise reconcile onto the command's target, so the command ends too.
      if (record?.owner && !record.owner.isCurrent()) {
        settleWrite(record, { status: 'refused', reason: 'superseded' })
        ;(instance as unknown as { cancelScroll?: () => void }).cancelScroll?.()
        return
      }
      const refused = record?.prechecked ? false : observer?.({ phase: 'before', source, behavior: options.behavior }) === false
      // A measurement write carries a resize correction for content above the reader.
      // virtual-core folds that adjustment into its own scrollOffset and clears it as soon as
      // it has called this function, whether or not the element moved. Skipping the write leaves
      // its layout offset out of sync with the DOM, with nothing left to reconcile it (#1510).
      // Suppressing an adjustment is done at `shouldAdjustScrollPositionOnItemSizeChange`, which
      // runs before anything is counted; refusing it here is not available to the observer.
      if (source !== 'measurement') {
        if (refused || !scroller || generationRef.current !== generation || instance.scrollElement !== scroller) {
          if (record) {
            settleWrite(record, {
              status: 'refused',
              reason: !scroller || instance.scrollElement !== scroller ? 'detached' : 'reader',
            })
          }
          return
        }
        elementScroll(offset, options, instance)
        if (record) {
          settleWrite(record, scroller
            ? { status: 'applied', offset: scroller.scrollTop }
            : { status: 'refused', reason: 'detached' })
        }
        // Record the physical write before publishing its read-back: the offset callback can
        // synchronously flush an iOS held correction and commit a larger spacer. Observing that
        // layout before this write is recorded mistakes its old-bottom clamp for reader movement.
        observer?.({ phase: 'after', source, behavior: options.behavior })
        // The DOM result is authoritative: the browser can clamp, round or drop a write. Publish
        // its actual offset here, not a destination after a possibly still-queued command returns.
        // Smooth writes have not landed yet; native events and rAF publish their real progress.
        // A navigation write is published at rest. The library's own writes (a hold flush, a clamp
        // retry, a prepend anchor sync) correct the content under a reader who may be scrolling.
        if (scroller && options.behavior !== 'smooth') {
          if (source === 'navigation') offsetCbRef.current?.(scroller.scrollTop, false)
          else reportWritten(instance, scroller.scrollTop)
        }
        return
      }
      // The library decided on `offset` when the row resized, and the observer above (or a scroll
      // the browser published since) may have moved the reader on. Writing that stale base back
      // erases the movement (#1601), and an adjustment approved for a row that is no longer above
      // the reader is wrong. So the adjustment is judged against the reader's live position and
      // added to it, and the library's write bookkeeping is pointed at what is actually written.
      // An estimate refresh measured its shift at that live position just before asking.
      const live = scroller?.scrollTop ?? offset
      const hold = (instance as unknown as { _holdOffset?: number })._holdOffset ?? 0
      const sameRows = instance.scrollElement === scroller && itemKeyRef.current?.items === rows
      const anchorIndex = heldAnchorIndex()
      const above = correction?.kind === 'estimates' ? sameRows
        : correction?.kind === 'resize' && sameRows
          && instance.options.getItemKey(correction.index) === correction.key
          && (anchorIndex !== undefined ? correction.index < anchorIndex
            : correction.first ? correction.start < live + hold : correction.end <= live + hold)
      const delta = above ? options.adjustments ?? 0 : 0
      retargetLibraryWrite(instance, live + hold, delta)
      elementScroll(live, { ...options, adjustments: delta }, instance)
      observer?.({ phase: 'after', source, behavior: options.behavior })
      if (instance.scrollElement) reportWritten(instance, instance.scrollElement.scrollTop)
    },
    measureElement: (element, entry, instance) => {
      writeObserverRef.current?.({ phase: 'before-measure', source: 'measurement' })
      if (instance.scrollElement && instance.scrollOffset !== instance.scrollElement.scrollTop) {
        // While the reader scrolls this is reported as motion. At rest it cleared the library's
        // isScrolling and direction mid-scroll, and with them its overscroll guard, so a correction
        // held through a rubber band was written mid-bounce. A position the library already holds
        // (the element sits behind it by that held correction) is then left alone.
        const top = instance.scrollElement.scrollTop
        if (scrollActivityRef.current.active) reportMotion(instance, top, false)
        else offsetCbRef.current?.(top, false)
      }
      // Preserve fractional border-box heights: integer rounding leaves seams or overlaps
      // between grouped message tints, especially after previews at scaled text sizes.
      // The mount path must measure live geometry rather than reuse a cached estimate.
      const size = entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height
      const index = instance.indexFromElement(element)
      const key = instance.options.getItemKey(index)
      // virtual-core resizes this row right after we return; its write is judged against this row.
      // Like virtual-core's own check, a first measurement is corrected once its top is above the
      // reader, a re-measurement only once the whole row is.
      const known = instance as unknown as { itemSizeCache?: Map<unknown, number> }
      const cached = instance.measurementsCache?.[index]
      const first = known.itemSizeCache ? !known.itemSizeCache.has(key) : true
      const start = cached?.start ?? Infinity
      correctionRef.current = index >= 0
        ? { kind: 'resize', index, key, start, end: start + (known.itemSizeCache?.get(key) ?? cached?.size ?? 0), first } : null
      if (index >= 0 && size > 0) onMeasuredRef.current?.(String(key), size)
      if (size > 0 && element.querySelector('[data-msg-text]') && !samplePendingRef.current) {
        samplePendingRef.current = true
        queueMicrotask(() => {
          samplePendingRef.current = false
          sampleEstimateMetricsRef.current?.()
        })
      }
      return size
    },
    // rAF-polled offset observer so the window keeps advancing during WebKit inertial momentum,
    // when the desktop webview withholds `scroll` events (the "looping rows" bug). See the fn doc.
    observeElementOffset: observeOffset,
    ...(initialMeasurementsCacheRef.current !== undefined ? { initialMeasurementsCache: initialMeasurementsCacheRef.current } : {}),
  })

  // Install the stable policy before initial row measurements. It reads live refs, so changing
  // suppression or the held anchor needs no reassignment and no render to take effect.
  if (virtualizer.shouldAdjustScrollPositionOnItemSizeChange !== shouldAdjustOnResize) {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = shouldAdjustOnResize
  }

  // virtual-core also writes from its commit-time update, run in a layout effect: a hold flush, a
  // clamp retry, a prepend anchor sync. React cannot render synchronously inside its commit, so a
  // read-back reported from there asks for no synchronous render (reportMotion). The method is
  // private: a library that renames it leaves those reports asking as the library would.
  const commitUpdate = virtualizer as unknown as { _willUpdate?: () => unknown; [COMMIT_TRACKED]?: true }
  if (typeof commitUpdate._willUpdate === 'function' && !commitUpdate[COMMIT_TRACKED]) {
    const willUpdate = commitUpdate._willUpdate
    commitUpdate._willUpdate = () => {
      committingRef.current = true
      try { return willUpdate() } finally { committingRef.current = false }
    }
    commitUpdate[COMMIT_TRACKED] = true
  }

  const getOffsetForMessageId = useCallback((id: string): number | null => {
    const index = indexById.get(id)
    if (index == null) return null
    // getOffsetForIndex(.., 'start') returns the row's start offset from the content top,
    // covering measured AND estimated rows (the private getMeasurements is not exposed). It
    // is clamped to the scrollable range, which only diverges from the raw start for rows in
    // the final viewport — the bottom-anchor path reads getVirtualItems() directly instead.
    return virtualizer.getOffsetForIndex(index, 'start')?.[0] ?? null
  }, [indexById, virtualizer])

  const getMessageStart = useCallback((id: string): number | null => {
    const index = indexById.get(id)
    if (index == null) return null
    // The same layout read as getOffsetForMessageId, without the scrollable-range clamp.
    return virtualizer.measurementsCache[index]?.start ?? null
  }, [indexById, virtualizer])

  const getIndexForMessageId = useCallback((id: string): number | null => {
    return indexById.get(id) ?? null
  }, [indexById])

  const newWrite = useCallback((owner?: ScrollWriteOwner): WriteRecord =>
    ({ id: ++writeIdRef.current, owner, command: null, scroller: null, prechecked: false, outcome: null }), [])

  // What a receipt reads. A write the library still holds is read from the library's own state,
  // so no watcher is needed: it is either still queued, written (scrollToFn settled it), or gone.
  const readOutcome = useCallback((record: WriteRecord): ScrollWriteOutcome => {
    if (record.outcome) return record.outcome
    if (record.command === null) return { status: 'refused', reason: 'dropped' }
    const detached = virtualizer.scrollElement !== record.scroller
    const state = (virtualizer as unknown as { scrollState?: ScrollCommandLike | null }).scrollState
    if (state === record.command && state.phase === 'queued') {
      if (detached) return settleWrite(record, { status: 'refused', reason: 'detached' })
      return record.owner && !record.owner.isCurrent()
        ? settleWrite(record, { status: 'refused', reason: 'superseded' })
        : { status: 'queued' }
    }
    return settleWrite(record, { status: 'refused', reason: detached ? 'detached' : 'dropped' })
  }, [virtualizer])

  // A held write ends for `reason` only if the library still holds it; one it already let go of
  // keeps the reason its own state gives (dropped, detached), whatever order callers poll in.
  const retireHeld = useCallback((record: WriteRecord, reason: 'superseded' | 'reader') => {
    if (readOutcome(record).status === 'queued') settleWrite(record, { status: 'refused', reason })
  }, [readOutcome])

  const receipt = useCallback((record: WriteRecord): ScrollWrite =>
    ({ id: record.id, outcome: () => readOutcome(record) }), [readOutcome])

  const navigate = useCallback((record: WriteRecord, write: () => void): ScrollWrite => {
    // A newer write replaces the command the library still holds for the previous one.
    const held = queuedWriteRef.current
    if (held) retireHeld(held, 'superseded')
    queuedWriteRef.current = null
    const generation = generationRef.current
    record.scroller = virtualizer.scrollElement
    const outer = currentWriteRef.current
    currentWriteRef.current = record
    try { write() }
    finally {
      currentWriteRef.current = outer
      // Only a command that survived the reader's takeover can own its later queued write.
      // Store its identity, not just a flag: replacement/cancellation must not lend it authority.
      if (generationRef.current === generation) {
        const command = (virtualizer as unknown as { scrollState?: ScrollCommandLike | null }).scrollState
        if (command?.phase === 'queued' && record.outcome === null) {
          record.command = command
          queuedWriteRef.current = record
        }
      }
    }
    if (record.outcome === null && record.command === null) {
      settleWrite(record, generationRef.current !== generation ? { status: 'refused', reason: 'reader' }
        : virtualizer.scrollElement ? { status: 'applied', offset: virtualizer.scrollElement.scrollTop }
        : { status: 'refused', reason: 'detached' })
    }
    return receipt(record)
  }, [receipt, retireHeld, virtualizer])

  const ensureMessageMounted = useCallback((id: string): Promise<void> => {
    const index = indexById.get(id)
    if (index == null) return Promise.resolve()
    navigate(newWrite(), () => virtualizer.scrollToIndex(index, { align: 'center' }))
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
  }, [indexById, navigate, newWrite, virtualizer])

  const cancelPendingScroll = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    generationRef.current++
    if (queuedWriteRef.current) retireHeld(queuedWriteRef.current, 'reader')
    queuedWriteRef.current = null
    // Drop the library target instead of replacing it with the current offset. A replacement
    // writes immediately during an iOS end pull, clamping the native rubber band (FLM-219),
    // and can re-land on the cancelled position after the reader starts moving (#1465).
    virtualizer.cancelScroll()
    // While the reader scrolls, the offset observer reports each position as motion. A report at
    // rest here would clear the library's isScrolling and direction, and the library would then
    // drop the scroll event's own report as a repeat of the position it already holds.
    if (!scrollActivityRef.current.active) offsetCbRef.current?.(scroller.scrollTop, false)
  }, [retireHeld, scrollRef, virtualizer])

  // The row an estimate refresh keeps where the reader sees it: the held anchor, or the row at the
  // reader's live offset. None while the caller owns the pixels, or while a smooth or written command
  // is landing, which virtual-core's own resize correction also leaves alone.
  const readEstimateAnchor = () => {
    const lib = virtualizer as unknown as CorrectionInternals
    const scroller = virtualizer.scrollElement
    const phase = lib.scrollState?.phase
    if (!adjustmentEnabledRef.current || !scroller || phase === 'smooth' || phase === 'smoothLanded'
      || lib._awaitingCommandReadBack?.()) return null
    virtualizer.getTotalSize()
    const index = heldAnchorRef.current !== null ? heldAnchorIndex()
      : virtualizer.getVirtualItemForOffset(scroller.scrollTop + (lib._holdOffset ?? 0))?.index
    const item = index === undefined ? undefined : virtualizer.measurementsCache[index]
    return item ? { index: item.index, key: item.key, start: item.start } : null
  }

  // A shift past what the scroller can still reach is clamped by the spacer the old estimates sized.
  // The window would then render at the clamped offset, mounting rows the reader is not looking at,
  // and their first measurements replace the library's recovery of the rest. So the taller layout
  // commits first, windowed where the reader is going; the write lands in the same task, before any
  // paint. A commit that cannot run synchronously leaves the clamp to the library as before.
  const commitRoomFor = (delta: number) => {
    const lib = virtualizer as unknown as CorrectionInternals
    const scroller = virtualizer.scrollElement
    const offset = virtualizer.scrollOffset
    if (!scroller || offset === null || lib._canWriteScroll?.() === false
      || delta <= scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) return
    virtualizer.scrollOffset = offset + delta
    try { virtualizer.options.onChange?.(virtualizer, true) }
    finally { virtualizer.scrollOffset = offset }
  }

  // Unlike a remeasurement, a refresh changes only estimates of rows nobody has seen, as a first
  // measurement does, so the shift is kept in either direction. It goes through the library's own
  // correction, which an iOS gesture defers, and is written like a resize correction. Returns whether
  // it moved the reader, whose transforms must then commit in the same paint.
  const keepEstimateAnchor = (anchor: NonNullable<ReturnType<typeof readEstimateAnchor>>): boolean => {
    const item = virtualizer.measurementsCache[anchor.index]
    const delta = item?.key === anchor.key ? item.start - anchor.start : 0
    const lib = virtualizer as unknown as CorrectionInternals
    if (delta === 0 || typeof lib.applyScrollAdjustment !== 'function') return false
    commitRoomFor(delta)
    correctionRef.current = { kind: 'estimates' }
    try { return lib.applyScrollAdjustment(delta) }
    finally { correctionRef.current = null }
  }

  return {
    cancelPendingScroll,
    hasPendingFling: () =>
      (virtualizer as unknown as { _iosGesture?: IosGestureLike })._iosGesture?.tail?.() === 'fling',
    refreshEstimates: (sync) => {
      // virtual-core re-derives the estimates of unmeasured rows only when its measurement options
      // change or a row resizes, and getOffsetForIndex reads the last derivation. A new getItemKey
      // identity is the option change that re-derives them while keeping every measured size; it
      // is kept for later renders so they do not derive a second time.
      const anchor = readEstimateAnchor()
      itemKeyRef.current = nextItemKey(itemKeyRef.current?.items ?? items)
      virtualizer.setOptions({ ...virtualizer.options, getItemKey: itemKeyRef.current.getItemKey })
      virtualizer.getTotalSize()
      const shifted = anchor !== null && keepEstimateAnchor(anchor)
      virtualizer.options.onChange?.(virtualizer, sync || shifted)
    },
    retainMessage: id => {
      if (retainedIdRef.current === id) return
      const previous = retainedIdRef.current
      retainedIdRef.current = id
      setRetainedId(id)
      if (previous !== null && id === null) cancelPendingScroll()
    },
    setScrollWriteObserver,
    setAutomaticScrollAdjustmentEnabled: (enabled) => {
      adjustmentEnabledRef.current = enabled
    },
    holdAnchor: (messageId) => {
      heldAnchorRef.current = messageId
    },
    getVirtualItems: () =>
      virtualizer.getVirtualItems().map((v) => ({ index: v.index, start: v.start, size: v.size, key: String(v.key) })),
    getTotalSize: () => virtualizer.getTotalSize(),
    itemCount: items.length,
    getOffsetForMessageId,
    getMessageStart,
    getIndexForMessageId,
    ensureMessageMounted,
    measureElement: virtualizer.measureElement,
    scrollToOffset: (offset, opts) => {
      const record = newWrite(opts?.owner)
      if (record.owner && !record.owner.isCurrent()) {
        settleWrite(record, { status: 'refused', reason: 'superseded' })
        return receipt(record)
      }
      // @tanstack/virtual-core 3.19.5+ queues an absolute write while an iOS drag, fling or bounce
      // is open and lands it ~100 ms after the gesture ends. A caller that owns the pixels closes
      // that gesture first, as the library does itself for a write it does not defer. Only an
      // unrefused write owns them: the reader-takeover check runs here, with the gesture still
      // open, so a refusal and its cancellation leave the reader's protection intact.
      const gesture = opts?.releaseGesture
        ? (virtualizer as unknown as { _iosGesture?: IosGestureLike })._iosGesture : undefined
      if (gesture) {
        const generation = generationRef.current
        const scroller = virtualizer.scrollElement
        const refused = writeObserverRef.current?.({ phase: 'before', source: 'navigation', behavior: opts?.behavior }) === false
        if (refused || generationRef.current !== generation || virtualizer.scrollElement !== scroller) {
          settleWrite(record, {
            status: 'refused',
            reason: virtualizer.scrollElement !== scroller ? 'detached' : 'reader',
          })
          return receipt(record)
        }
        gesture.end?.()
        record.prechecked = true
      }
      return navigate(record, () => virtualizer.scrollToOffset(offset, opts && { behavior: opts.behavior }))
    },
    beginAnimatedScrollToOffset: (offset) => {
      navigate(newWrite(), () => virtualizer.scrollToOffset(offset, { behavior: 'smooth' }))
    },
    scrollToIndex: (index, opts) => {
      const record = newWrite(opts?.owner)
      if (record.owner && !record.owner.isCurrent()) {
        settleWrite(record, { status: 'refused', reason: 'superseded' })
        return receipt(record)
      }
      const libraryOpts = opts && { align: opts.align, behavior: opts.behavior }
      return navigate(record, () => virtualizer.scrollToIndex(index, libraryOpts))
    },
  }
}
