import type { LastActivityResult } from '../types/admin'

/** Default number of last-activity queries allowed in flight at once. */
export const LAST_ACTIVITY_CONCURRENCY = 6

export interface LastActivityQueueCallbacks {
  /** Perform the actual query for a bare JID. */
  fetch: (jid: string) => Promise<LastActivityResult>
  /**
   * Called with the resolved seconds (or null when unknown for this user).
   * `raw` is a display fallback for when seconds is null but a value is
   * otherwise known (e.g. an unparseable admin last-login string).
   */
  onResult: (jid: string, seconds: number | null, raw?: string | null) => void
  /** Called once when the server reports the feature is unsupported. */
  onUnsupported: () => void
}

/**
 * Bounded-concurrency queue for lazy per-row last-activity queries.
 * Dedupes by JID, caps in-flight requests, and stops permanently once the
 * server reports the feature is unsupported (so we never flood a server
 * without mod_last).
 */
export class LastActivityQueue {
  private readonly queue: string[] = []
  private readonly seen = new Set<string>()
  private active = 0
  private stopped = false

  constructor(
    private readonly cb: LastActivityQueueCallbacks,
    private readonly concurrency: number = LAST_ACTIVITY_CONCURRENCY
  ) {}

  enqueue(jid: string): void {
    if (this.stopped || this.seen.has(jid)) return
    this.seen.add(jid)
    this.queue.push(jid)
    this.pump()
  }

  stop(): void {
    this.stopped = true
    this.queue.length = 0
  }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.queue.length > 0) {
      const jid = this.queue.shift() as string
      this.active++
      this.cb
        .fetch(jid)
        .then((res) => {
          if (res.unsupported) {
            this.stop()
            this.cb.onUnsupported()
          } else {
            this.cb.onResult(jid, res.seconds, res.raw)
          }
        })
        .catch(() => this.cb.onResult(jid, null))
        .finally(() => {
          this.active--
          this.pump()
        })
    }
  }
}
