import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react'
import { useRemeasureOnWidthChange } from './messageWidthContext'

/**
 * Shared-width coordination for a run of consecutive OWN (outgoing) messages so
 * their tinted backgrounds form ONE clean rectangle sized to the group's widest
 * line — even though the virtualized timeline renders each row as a flat,
 * independent sibling with no per-group DOM container to hang a CSS solution on.
 *
 * Efficiency contract (the whole reason this is a bespoke registry, not state):
 *  - The group width is applied IMPERATIVELY as a `min-width` (never React state
 *    or props), so measurement never triggers a re-render and there is no
 *    measure → render → measure feedback loop. It is a MINIMUM, not a hard width:
 *    shorter rows stretch up to it so the tint reads as one rectangle, but a row
 *    whose content is wider than a stale/under-measured max grows to fit its line
 *    (the box stays `w-fit`) instead of being forced to wrap. Upholds the rule
 *    "never wrap a line that would otherwise fit on one row."
 *  - Every dirty group is flushed in ONE microtask with reads strictly before
 *    writes: the browser does a single layout pass and never thrashes. The flush
 *    runs before paint, so a group snaps to its rectangle in the same frame it
 *    mounts or scrolls in — no ragged-edge flicker.
 *  - Only MULTI-row own groups register. A solo own message (the common case)
 *    keeps its plain CSS `w-fit` and pays nothing.
 *  - We widen only the background box; the text inside stays `w-fit`, so row
 *    HEIGHTS never change and the virtualizer / scroll anchoring are untouched.
 */

interface GroupEntry {
  /** Currently-mounted members of this group, by message id. */
  mounted: Map<string, HTMLElement>
}

export class OwnGroupWidthRegistry {
  private groups = new Map<string, GroupEntry>()
  private dirty = new Set<string>()
  private scheduled = false

  register(groupId: string, memberId: string, el: HTMLElement): void {
    let g = this.groups.get(groupId)
    if (!g) {
      g = { mounted: new Map() }
      this.groups.set(groupId, g)
    }
    g.mounted.set(memberId, el)
    this.markDirty(groupId)
  }

  unregister(groupId: string, memberId: string): void {
    const g = this.groups.get(groupId)
    if (!g) return
    // Return the leaving row to its natural CSS width so a regrouped row (or a
    // row scrolling back in) never keeps a stale pinned width.
    const el = g.mounted.get(memberId)
    if (el) {
      el.style.width = ''
      el.style.minWidth = ''
    }
    g.mounted.delete(memberId)
    if (g.mounted.size === 0) {
      this.groups.delete(groupId)
      this.dirty.delete(groupId)
      return
    }
    // A removed member may have been the widest — re-fit the survivors.
    this.markDirty(groupId)
  }

  /** Mark one group for re-measure (member added/removed, or content changed). */
  markDirty(groupId: string): void {
    if (!this.groups.has(groupId)) return
    this.dirty.add(groupId)
    this.schedule()
  }

  /** Container width changed → text rewraps → every group's max may shift. */
  markAllDirty(): void {
    for (const id of this.groups.keys()) this.dirty.add(id)
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled || this.dirty.size === 0) return
    this.scheduled = true
    queueMicrotask(() => this.flush())
  }

  private flush(): void {
    this.scheduled = false
    const entries: GroupEntry[] = []
    for (const id of this.dirty) {
      const g = this.groups.get(id)
      if (g && g.mounted.size) entries.push(g)
    }
    this.dirty.clear()
    if (entries.length === 0) return

    // Phase 1 (write): free every member to its natural width so we can read it.
    // Reset any prior `min-width` too, or a stale pin would inflate the reading
    // and the group max could only ever ratchet upward.
    for (const g of entries) {
      for (const el of g.mounted.values()) {
        el.style.width = 'max-content'
        el.style.minWidth = '0'
      }
    }
    // Phase 2 (read): a single forced layout for the whole batch, then the max
    // natural width per group. `max-content` is still clamped by the box's
    // `max-w-full`, so a long/wrapping line reads as the available width and its
    // group becomes full-width — exactly as before.
    const maxes = entries.map((g) => {
      let max = 0
      for (const el of g.mounted.values()) {
        const w = el.offsetWidth
        if (w > max) max = w
      }
      return max
    })
    // Phase 3 (write): size every member to the group max via `min-width`, not a
    // hard `width`, and release the measurement width back to the CSS `w-fit`.
    // `min(${max}px, 100%)`: shorter rows stretch UP to the group max so the tint
    // reads as one clean rectangle, but a row whose content is wider than a
    // stale/under-measured max grows to fit its line instead of being forced to
    // wrap; the `100%` term keeps a stale-too-wide max from overflowing the
    // column (a min-width alone would win over `max-w-full`). Skip a zero measure
    // (e.g. a layout-less test environment) so the box keeps its plain `w-fit`.
    for (let i = 0; i < entries.length; i++) {
      const max = maxes[i]
      const minWidth = max > 0 ? `min(${max}px, 100%)` : ''
      for (const el of entries[i].mounted.values()) {
        el.style.width = ''
        el.style.minWidth = minWidth
      }
    }
  }
}

const OwnGroupWidthContext = createContext<OwnGroupWidthRegistry | null>(null)

export function OwnGroupWidthProvider({ children }: { children: ReactNode }) {
  const registryRef = useRef<OwnGroupWidthRegistry | null>(null)
  if (!registryRef.current) registryRef.current = new OwnGroupWidthRegistry()
  const registry = registryRef.current

  // Container width change → text rewraps → natural widths change → re-fit all.
  // Reuses the list's single debounced ResizeObserver (no per-row observers).
  useRemeasureOnWidthChange(() => registry.markAllDirty())

  return <OwnGroupWidthContext.Provider value={registry}>{children}</OwnGroupWidthContext.Provider>
}

/**
 * Attach the returned `ref` to a grouped own-message's tint box so it shares the
 * group's width. Pass `groupId === undefined` for solo/incoming rows (the box
 * then keeps its CSS `w-fit`); safe with no provider (tests no-op too).
 *
 * `widthSignature` is any value derived from the row's width-affecting content
 * (body, reactions, reply, attachment…). When it changes, the group re-measures;
 * hover/selection churn leaves it untouched, so those re-renders cost nothing.
 *
 * The returned `remeasure` re-fits the group on demand — used when a member's
 * media (image/video/link-preview) finishes loading and only THEN reaches its
 * final layout width. The initial measure at mount happens before the media
 * settles, so without this the group stays pinned to the pre-load (too-narrow)
 * width and the loaded row overflows it. No-op when the row is solo/incoming.
 */
export function useOwnGroupWidth(
  groupId: string | undefined,
  memberId: string,
  widthSignature: unknown,
): { ref: (node: HTMLDivElement | null) => void; remeasure: () => void } {
  const registry = useContext(OwnGroupWidthContext)
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const active = registry != null && groupId != null

  useLayoutEffect(() => {
    if (!active) return
    const node = nodeRef.current
    if (!node) return
    registry.register(groupId, memberId, node)
    return () => registry.unregister(groupId, memberId)
    // widthSignature re-runs the effect on content change: the cleanup unregisters
    // and the setup re-registers the same node, marking the group dirty so it
    // re-fits. The transient unregister settles before the microtask flush.
  }, [registry, active, groupId, memberId, widthSignature])

  const ref = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node
  }, [])

  const remeasure = useCallback(() => {
    if (active) registry.markDirty(groupId)
  }, [registry, active, groupId])

  return { ref, remeasure }
}
