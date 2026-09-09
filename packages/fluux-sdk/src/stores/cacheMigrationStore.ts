import { createStore } from 'zustand/vanilla'

/** Progress of a local message-cache upgrade; null percent means preparation. */
export interface CacheMigrationProgress {
  /** Percentage of the canonical-row scan, capped at 99 until the upgrade commits. */
  percent: number | null
}

export interface CacheMigrationState {
  /** Null outside an upgrade, including ordinary reads and first-time cache creation. */
  progress: CacheMigrationProgress | null
}

/** Transient status for the current account's local message-cache migration. */
export const cacheMigrationStore = createStore<CacheMigrationState>(() => ({ progress: null }))

let generation = 0

/** @internal An account change invalidates progress from the previous cache. */
export function resetCacheMigration(): void {
  generation++
  if (cacheMigrationStore.getState().progress) cacheMigrationStore.setState({ progress: null })
}

/** @internal Owned by one IndexedDB open request, through commit or failure. */
export function beginCacheMigration() {
  const owner = ++generation
  cacheMigrationStore.setState({ progress: { percent: null } })
  return {
    report(processed: number, total: number) {
      if (owner !== generation) return
      // The row scan is not a commit: reserve completion until openDB resolves.
      const percent = total > 0 ? Math.min(99, Math.floor(processed * 100 / total)) : 99
      if (cacheMigrationStore.getState().progress?.percent !== percent) {
        cacheMigrationStore.setState({ progress: { percent } })
      }
    },
    finish() {
      if (owner === generation) resetCacheMigration()
    },
  }
}
