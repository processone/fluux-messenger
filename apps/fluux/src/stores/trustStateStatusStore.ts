import { create } from 'zustand'

/**
 * Trust-state integrity status, re-evaluated on every session.
 *
 * - `uninitialized` — fresh install, no trust state to protect yet.
 * - `sealed`        — signed blob matches current stores.
 * - `pending-seal`  — stores populated but no blob yet (migration).
 * - `compromised`   — blob absent/invalid/stale when stores non-empty.
 *
 * Not persisted: the check runs on every plugin init after the key
 * becomes available, producing a fresh verdict each session.
 */
export type TrustStateStatus =
  | 'uninitialized'
  | 'sealed'
  | 'pending-seal'
  | 'compromised'

interface TrustStateStatusState {
  status: TrustStateStatus
  mismatchDetails?: string[]
  setStatus: (status: TrustStateStatus, details?: string[]) => void
  clear: () => void
}

export const useTrustStateStatusStore = create<TrustStateStatusState>((set) => ({
  status: 'uninitialized',
  mismatchDetails: undefined,
  setStatus: (status, mismatchDetails) => set({ status, mismatchDetails }),
  clear: () => set({ status: 'uninitialized', mismatchDetails: undefined }),
}))

export function setTrustStateStatus(status: TrustStateStatus, details?: string[]): void {
  useTrustStateStatusStore.getState().setStatus(status, details)
}

export function getTrustStateStatus(): TrustStateStatus {
  return useTrustStateStatusStore.getState().status
}
