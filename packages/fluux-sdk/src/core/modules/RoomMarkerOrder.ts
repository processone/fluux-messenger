/**
 * Proven room-archive order. Opaque IDs are vertices, never sortable values.
 * Only server-ordered MAM pages and consecutive undelayed room deliveries add
 * edges. Missing edges mean unknown, not a nickname/client-ID/time fallback.
 */
export class RoomMarkerOrder {
  private edges = new Map<string, Set<string>>()
  private liveLast: string | undefined
  revision = 0

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
  private vertex(id: string) {
    if (!id || this.edges.has(id)) return
    if (this.edges.size >= 4096) { this.edges.clear(); this.liveLast = undefined }
    this.edges.set(id, new Set())
    this.revision++
  }
  private link(earlier: string, later: string) {
    if (!earlier || !later || earlier === later || this.after(earlier, later)) return
    this.vertex(earlier); this.vertex(later)
    const next = this.edges.get(earlier) ?? new Set<string>()
    if (next.has(later)) return
    next.add(later)
    this.edges.set(earlier, next)
    this.revision++
  }
  page(ids: readonly string[], cursor?: { before?: string; after?: string }) {
    // Even an unlinked new vertex invalidates a previously observed archive end.
    for (const id of ids) this.vertex(id)
    for (let i = 1; i < ids.length; i++) this.link(ids[i - 1], ids[i])
    if (ids.length && cursor?.after) this.link(cursor.after, ids[0])
    if (ids.length && cursor?.before) this.link(ids[ids.length - 1], cursor.before)
  }
  live(id: string) {
    if (this.liveLast && (id === this.liveLast || this.after(this.liveLast, id))) return
    const previous = this.liveLast
    this.vertex(id)
    if (previous) this.link(previous, id)
    this.liveLast = id
  }
}
