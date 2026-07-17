/**
 * Per-entity serialization of archive-page write outcomes (Codex r4 #4).
 *
 * Room forward catch-up merges one page at a time, each with its own
 * IndexedDB transaction. A deferred gap/coverage commit for page N+1 must not
 * apply unless EVERY earlier in-flight page for the same entity committed
 * too — otherwise page N+1's cursor advance leaps over a failed page N and
 * the resume skips it forever.
 *
 * `chain(id, save)` returns a gate promise that resolves `true` only when the
 * given save AND all previously-chained saves for that entity succeeded. A
 * failure poisons the entity's chain for the session (conservative: the
 * durable cursor freezes; the next session re-fetches from the stale cursor
 * and dedupes). The chain entry self-clears once it drains successfully, so
 * the steady state holds no entries.
 *
 * @module Stores/Shared/ArchiveSaveChain
 */

export interface ArchiveSaveChain {
  /** Gate `save` on all earlier in-flight saves for `id` (cumulative AND). */
  chain: (id: string, save: Promise<boolean>) => Promise<boolean>
  /** True when `id` has an in-flight (or poisoned) chain entry. */
  has: (id: string) => boolean
  /** Drop all entries (store reset / account switch). */
  clear: () => void
}

export function createArchiveSaveChain(): ArchiveSaveChain {
  const chains = new Map<string, Promise<boolean>>()
  return {
    chain(id, save) {
      const prior = chains.get(id) ?? Promise.resolve(true)
      const chained = Promise.all([prior, save]).then(([a, b]) => a && b)
      chains.set(id, chained)
      void chained.then((ok) => {
        // Reset on full success so a session-long poison only follows an
        // actual failure; keep the poisoned entry otherwise.
        if (ok && chains.get(id) === chained) chains.delete(id)
      })
      return chained
    },
    has(id) {
      return chains.has(id)
    },
    clear() {
      chains.clear()
    },
  }
}
