/**
 * Proven room-archive order. Opaque IDs are vertices, never sortable values.
 * Only server-ordered MAM pages and consecutive undelayed room deliveries add
 * edges. Missing edges mean unknown, not a nickname/client-ID/time fallback.
 */
export class RoomMarkerOrder {
  private edges = new Map<string, Set<string>>()
  private liveLast: string | undefined

  after(candidate: string, previous: string): boolean {
    if (candidate === previous) return false
    const visited = new Set<string>()
    const pending = [previous]
    while (pending.length) {
      const id = pending.pop()!
      if (id === candidate) return true
      if (visited.has(id)) continue
      visited.add(id)
      for (const next of this.edges.get(id) ?? []) pending.push(next)
    }
    return false
  }
  private link(earlier: string, later: string) {
    if (!earlier || !later || earlier === later || this.after(earlier, later)) return
    const next = this.edges.get(earlier) ?? new Set<string>()
    next.add(later)
    this.edges.set(earlier, next)
    // Losing old order evidence is safe: the caller can probe it again. Keep
    // long-lived room sessions from retaining an unbounded archive graph.
    if (this.edges.size > 4096) { this.edges.clear(); this.liveLast = undefined }
  }
  page(ids: readonly string[], cursor?: { before?: string; after?: string }) {
    for (let i = 1; i < ids.length; i++) this.link(ids[i - 1], ids[i])
    if (ids.length && cursor?.after) this.link(cursor.after, ids[0])
    if (ids.length && cursor?.before) this.link(ids[ids.length - 1], cursor.before)
  }
  live(id: string) {
    if (this.liveLast && (id === this.liveLast || this.after(this.liveLast, id))) return
    if (this.liveLast) this.link(this.liveLast, id)
    this.liveLast = id
  }
}
