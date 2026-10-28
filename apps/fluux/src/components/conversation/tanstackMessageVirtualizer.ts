import { useCallback, useEffect, useRef, useState } from 'react'
import { defaultRangeExtractor, elementScroll, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { MessageVirtualizer } from './messageVirtualizer'

// Frames the offset must hold steady before we declare scrolling settled and stop polling
// (~100ms at 60fps — close to @tanstack's default 150ms isScrollingResetDelay).
const OFFSET_POLL_IDLE_FRAMES = 6
const suppressScrollAdjustment = () => false
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
 * The poll stops after the offset is stable for OFFSET_POLL_IDLE_FRAMES, so it runs only during an
 * active scroll. It is strictly READ-ONLY (never writes scrollTop) so it cannot feed back into the
 * scroll-correction loops. Same `(instance, cb) => cleanup` contract as the @tanstack default.
 */
export function observeElementOffsetWithRaf(
  instance: { scrollElement: HTMLElement | null },
  cb: (offset: number, isScrolling: boolean) => void,
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
      cb(offset, true)
    } else if (++idleFrames >= OFFSET_POLL_IDLE_FRAMES) {
      rafId = null
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

  const onScroll = () => {
    lastOffset = el.scrollTop
    cb(lastOffset, true)
    startPolling()
  }

  el.addEventListener('scroll', onScroll, { passive: true })
  // Momentum initiators: WebKit may suppress the `scroll` event during the inertial phase, so
  // begin polling the moment the gesture starts rather than waiting for a `scroll` that won't come.
  el.addEventListener('wheel', startPolling, { passive: true })
  el.addEventListener('touchmove', startPolling, { passive: true })

  return () => {
    el.removeEventListener('scroll', onScroll)
    el.removeEventListener('wheel', startPolling)
    el.removeEventListener('touchmove', startPolling)
    if (rafId !== null) cancelAnimationFrame(rafId)
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
type IosGestureLike = { end?: () => void }
// Private command identity: virtual-core keeps this object when a queued command starts writing.
type ScrollCommandLike = { phase?: string }

export function useTanstackMessageVirtualizer({
  items, indexById, scrollRef, estimateSize = 64, sampleEstimateMetrics, initialMeasurements, onMeasured,
}: Args): MessageVirtualizer {
  const overscan = useEntryOverscan(items.length > 0)
  const [retainedId, setRetainedId] = useState<string | null>(null)
  const retainedIdRef = useRef<string | null>(null)
  const writeObserverRef = useRef<Parameters<NonNullable<MessageVirtualizer['setScrollWriteObserver']>>[0]>(undefined)
  const navigationWriteRef = useRef(false)
  const queuedNavigationRef = useRef<ScrollCommandLike | null>(null)
  // The outcome of the reader-takeover check scrollToOffset already ran before releasing a gesture.
  const precheckedRef = useRef<{ refused: boolean } | null>(null)
  // Set by cancelPendingScroll until the next navigation write. See there.
  const cancelledTargetRef = useRef(false)
  // Bumped whenever the reader takes the pixels: any destination decided earlier is void.
  const generationRef = useRef(0)
  // The row virtual-core is about to resize, as seen by the measurement that precedes its write.
  const measuringRef = useRef<{ index: number; key: ReturnType<Virtualizer<HTMLElement, Element>['options']['getItemKey']>; start: number; end: number; first: boolean } | null>(null)
  const setScrollWriteObserver = useCallback<NonNullable<MessageVirtualizer['setScrollWriteObserver']>>(
    observer => { writeObserverRef.current = observer }, [],
  )
  // Which rows a resize compensates: the library's rule (rows above the viewport top), none while
  // the caller owns the pixels, or the rows before a held anchor. See holdAnchor.
  const adjustmentEnabledRef = useRef(true)
  const heldAnchorRef = useRef<string | null>(null)
  const indexByIdRef = useRef(indexById)
  indexByIdRef.current = indexById
  const heldAnchorIndex = () =>
    heldAnchorRef.current === null ? undefined : indexByIdRef.current.get(heldAnchorRef.current)
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
  // without waiting for a native event. Queued navigation keeps its command identity until that
  // first write; the caller returning does not turn it into layout reconciliation. The non-sync
  // callback uses plain rerender() rather than a synthetic scroll event's flushSync, which is
  // illegal during a MAM-prepend restore useLayoutEffect.
  const offsetCbRef = useRef<((offset: number, isScrolling: boolean) => void) | null>(null)
  const observeOffset = useCallback(
    (instance: Virtualizer<HTMLElement, Element>, cb: (offset: number, isScrolling: boolean) => void) => {
      offsetCbRef.current = cb
      const cleanup = observeElementOffsetWithRaf(instance, cb)
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
      const queued = queuedNavigationRef.current
      // _writeAwaitingCommand changes the same command's phase before its first write. A hold
      // flush that precedes it is still queued, and a row-size adjustment is not that command.
      const queuedWrite = queued !== null && command === queued
        && command.phase !== 'queued' && options.adjustments === undefined
      if (queuedWrite || (queued !== null && command !== queued)) queuedNavigationRef.current = null
      const source = navigationWriteRef.current || queuedWrite ? 'navigation'
        : options.adjustments !== undefined ? 'measurement' : 'reconcile'
      if (source === 'navigation') cancelledTargetRef.current = false
      else if (source === 'reconcile' && cancelledTargetRef.current) return
      // The write's authority: the destination generation, scroller and row set it was decided under.
      // The observer below can hand the pixels to the reader (cancelPendingScroll) before we write.
      const generation = generationRef.current
      // Taken before the observer: its takeover writes (and so re-enters this function) too.
      const measuring = source === 'measurement' ? measuringRef.current : null
      if (source === 'measurement') measuringRef.current = null
      const scroller = instance.scrollElement
      const rows = itemKeyRef.current?.items
      const observer = writeObserverRef.current
      const prechecked = precheckedRef.current
      precheckedRef.current = null
      const refused = prechecked ? prechecked.refused : observer?.({ phase: 'before', source, behavior: options.behavior }) === false
      // A measurement write carries the adjustment for a row that measured taller than its
      // estimate above the reader. virtual-core folds that adjustment into its own scrollOffset
      // and clears it as soon as it has called this function, whether or not the element moved,
      // so skipping the write leaves its offset permanently ahead of the DOM and the reader
      // stranded that many pixels above the live edge with nothing left to reconcile it (#1510).
      // Suppressing an adjustment is done at `shouldAdjustScrollPositionOnItemSizeChange`, which
      // runs before anything is counted; refusing it here is not available to the observer.
      if (source !== 'measurement') {
        if (refused || generationRef.current !== generation || instance.scrollElement !== scroller) return
        elementScroll(offset, options, instance)
        // The DOM result is authoritative: the browser can clamp, round or drop a write. Publish
        // its actual offset here, not a destination after a possibly still-queued command returns.
        // Smooth writes have not landed yet; native events and rAF publish their real progress.
        if (scroller && options.behavior !== 'smooth') offsetCbRef.current?.(scroller.scrollTop, false)
        observer?.({ phase: 'after', source, behavior: options.behavior })
        return
      }
      // The library decided on `offset` when the row resized, and the observer above (or a scroll
      // the browser published since) may have moved the reader on. Writing that stale base back
      // erases the movement (#1601), and an adjustment approved for a row that is no longer above
      // the reader is wrong. So the adjustment is judged against the reader's live position and
      // added to it, and the library's write bookkeeping is pointed at what is actually written.
      const live = scroller?.scrollTop ?? offset
      const hold = (instance as unknown as { _holdOffset?: number })._holdOffset ?? 0
      const sameRow = measuring !== null
        && instance.scrollElement === scroller && itemKeyRef.current?.items === rows
        && instance.options.getItemKey(measuring.index) === measuring.key
      const anchorIndex = heldAnchorIndex()
      const above = sameRow && (anchorIndex !== undefined ? measuring.index < anchorIndex
        : measuring.first ? measuring.start < live + hold : measuring.end <= live + hold)
      const delta = above ? options.adjustments ?? 0 : 0
      retargetLibraryWrite(instance, live + hold, delta)
      elementScroll(live, { ...options, adjustments: delta }, instance)
      observer?.({ phase: 'after', source, behavior: options.behavior })
      if (instance.scrollElement) offsetCbRef.current?.(instance.scrollElement.scrollTop, false)
    },
    measureElement: (element, entry, instance) => {
      writeObserverRef.current?.({ phase: 'before-measure', source: 'measurement' })
      if (instance.scrollElement && instance.scrollOffset !== instance.scrollElement.scrollTop) {
        offsetCbRef.current?.(instance.scrollElement.scrollTop, false)
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
      measuringRef.current = index >= 0
        ? { index, key, start, end: start + (known.itemSizeCache?.get(key) ?? cached?.size ?? 0), first } : null
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

  // A held anchor stays still: a row before it that resizes moves the scroll position by the same
  // amount, wherever it sits, so a row between the viewport top and the anchor (which the library
  // leaves alone) cannot push the anchor down. An anchor that left the rows compensates nothing
  // until the holder lets go.
  const applyAdjustmentRule = () => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = !adjustmentEnabledRef.current
      ? suppressScrollAdjustment
      : heldAnchorRef.current === null ? undefined
      : (item) => {
          const anchorIndex = heldAnchorIndex()
          return anchorIndex !== undefined && item.index < anchorIndex
        }
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

  const navigate = useCallback((write: () => void) => {
    queuedNavigationRef.current = null
    const generation = generationRef.current
    const wasNavigation = navigationWriteRef.current
    navigationWriteRef.current = true
    try { write() }
    finally {
      navigationWriteRef.current = wasNavigation
      // Only a command that survived the reader's takeover can own its later queued write.
      // Store its identity, not just a flag: replacement/cancellation must not lend it authority.
      if (generationRef.current === generation) {
        const command = (virtualizer as unknown as { scrollState?: ScrollCommandLike | null }).scrollState
        queuedNavigationRef.current = command?.phase === 'queued' ? command : null
      }
    }
  }, [virtualizer])

  const ensureMessageMounted = useCallback((id: string): Promise<void> => {
    const index = indexById.get(id)
    if (index == null) return Promise.resolve()
    navigate(() => virtualizer.scrollToIndex(index, { align: 'center' }))
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
  }, [indexById, navigate, virtualizer])

  const cancelPendingScroll = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    generationRef.current++
    queuedNavigationRef.current = null
    const wasNavigation = navigationWriteRef.current
    navigationWriteRef.current = true
    try { virtualizer.scrollToOffset(scroller.scrollTop) }
    finally { navigationWriteRef.current = wasNavigation }
    // The write above retargets @tanstack/virtual-core's private pending scroll to the current
    // offset, and the library re-lands on that target until a settled frame. A user scroll that
    // starts first moves less than its 1px arrival tolerance on the first step, and that landing
    // would write the old offset back and end the scroll (#1465). A cancelled target is never
    // worth re-landing on, so its reconcile writes are skipped; the pending state itself stays,
    // because the library also uses it to measure rows synchronously.
    cancelledTargetRef.current = true
    offsetCbRef.current?.(scroller.scrollTop, false)
  }, [scrollRef, virtualizer])

  return {
    cancelPendingScroll,
    refreshEstimates: (sync) => {
      // virtual-core re-derives the estimates of unmeasured rows only when its measurement options
      // change or a row resizes, and getOffsetForIndex reads the last derivation. A new getItemKey
      // identity is the option change that re-derives them while keeping every measured size; it
      // is kept for later renders so they do not derive a second time.
      itemKeyRef.current = nextItemKey(itemKeyRef.current?.items ?? items)
      virtualizer.setOptions({ ...virtualizer.options, getItemKey: itemKeyRef.current.getItemKey })
      virtualizer.getTotalSize()
      virtualizer.options.onChange?.(virtualizer, sync)
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
      applyAdjustmentRule()
    },
    holdAnchor: (messageId) => {
      heldAnchorRef.current = messageId
      applyAdjustmentRule()
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
      // @tanstack/virtual-core 3.19.5+ queues an absolute write while an iOS drag, fling or bounce
      // is open and lands it ~100 ms after the gesture ends. A caller that owns the pixels closes
      // that gesture first, as the library does itself for a write it does not defer. Only an
      // unrefused write owns them: the reader-takeover check runs here, with the gesture still
      // open, so a refusal (and the takeover write it makes) leaves the reader's protection intact.
      const gesture = opts?.releaseGesture
        ? (virtualizer as unknown as { _iosGesture?: IosGestureLike })._iosGesture : undefined
      let write = true
      if (gesture) {
        cancelledTargetRef.current = false
        const generation = generationRef.current
        const scroller = virtualizer.scrollElement
        const refused = writeObserverRef.current?.({ phase: 'before', source: 'navigation', behavior: opts?.behavior }) === false
        write = !refused && generationRef.current === generation && virtualizer.scrollElement === scroller
        if (write) {
          gesture.end?.()
          precheckedRef.current = { refused: false }
        }
      }
      if (write) {
        try { navigate(() => virtualizer.scrollToOffset(offset, opts && { behavior: opts.behavior })) }
        finally { precheckedRef.current = null }
      }
    },
    beginAnimatedScrollToOffset: (offset) => {
      navigate(() => virtualizer.scrollToOffset(offset, { behavior: 'smooth' }))
    },
    scrollToIndex: (index, opts) => {
      navigate(() => virtualizer.scrollToIndex(index, opts))
    },
  }
}
