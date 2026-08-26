/**
 * Value-only bookkeeping for virtual-row measurements. Pixel decisions and writes remain owned by
 * the positioning controller; these helpers only retain a bounded size baseline and coalesce the
 * positive deltas reported during one animation frame.
 */
export const MAX_TRACKED_VIRTUAL_ROW_SIZES = 512

export class VirtualRowSizeHistory {
  private context: string | null = null
  private readonly sizes = new Map<string, number>()

  observe(conversationId: string, scalePct: number, rowKey: string, size: number): number | null {
    const context = `${conversationId}\u0000${scalePct}`
    if (context !== this.context) {
      this.context = context
      this.sizes.clear()
    }

    const previousSize = this.sizes.get(rowKey)
    // Map insertion order is our LRU order. Refresh existing rows as well as adding new ones.
    this.sizes.delete(rowKey)
    this.sizes.set(rowKey, size)
    while (this.sizes.size > MAX_TRACKED_VIRTUAL_ROW_SIZES) {
      const oldest = this.sizes.keys().next().value
      if (oldest === undefined) break
      this.sizes.delete(oldest)
    }
    return previousSize !== undefined && size > previousSize ? size - previousSize : null
  }
}

type RequestFrame = (callback: FrameRequestCallback) => number
type CancelFrame = (frameId: number) => void

export class VirtualRowGrowthBatcher {
  private pending: { conversationId: string; heightDelta: number; frameId: number } | null = null

  constructor(
    private readonly flush: (conversationId: string, heightDelta: number) => void,
    private readonly requestFrame: RequestFrame = requestAnimationFrame,
    private readonly cancelFrame: CancelFrame = cancelAnimationFrame,
  ) {}

  enqueue(conversationId: string, heightDelta: number): void {
    if (!(heightDelta > 0)) return
    if (this.pending) {
      if (this.pending.conversationId === conversationId) {
        this.pending.heightDelta += heightDelta
        return
      }
      // A frame captured for the room we just left must not consume growth already measured in the
      // room we entered. Supersede the obsolete batch and give the active room its own frame.
      this.cancelFrame(this.pending.frameId)
      this.pending = null
    }

    const pending = { conversationId, heightDelta, frameId: 0 }
    this.pending = pending
    pending.frameId = this.requestFrame(() => {
      if (this.pending !== pending) return
      this.pending = null
      this.flush(pending.conversationId, pending.heightDelta)
    })
  }

  dispose(): void {
    if (!this.pending) return
    this.cancelFrame(this.pending.frameId)
    this.pending = null
  }
}
