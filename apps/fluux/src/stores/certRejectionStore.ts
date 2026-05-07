import { create } from 'zustand'

export type CertRejectionCode =
  | 'validation_failed'
  | 'fingerprint_mismatch'
  | 'uid_mismatch'

export interface CertRejection {
  fingerprint: string
  code: CertRejectionCode
  detail: string
  observedAt: string
}

interface CertRejectionState {
  rejectionsByJid: Record<string, CertRejection[]>
  setRejections: (jid: string, rejections: CertRejection[]) => void
  clearRejections: (jid: string) => void
}

const STORAGE_KEY = 'fluux-e2ee-cert-rejections'

function loadInitial(): Record<string, CertRejection[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, CertRejection[]> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every(isValidRejection)) {
        out[k] = v as CertRejection[]
      }
    }
    return out
  } catch {
    return {}
  }
}

function isValidRejection(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const r = v as CertRejection
  return (
    typeof r.fingerprint === 'string' &&
    typeof r.code === 'string' &&
    typeof r.detail === 'string' &&
    typeof r.observedAt === 'string'
  )
}

function persist(map: Record<string, CertRejection[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Best-effort persistence.
  }
}

function rejectionsEqual(a: CertRejection[], b: CertRejection[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].fingerprint !== b[i].fingerprint || a[i].code !== b[i].code || a[i].detail !== b[i].detail) {
      return false
    }
  }
  return true
}

export const useCertRejectionStore = create<CertRejectionState>((set) => ({
  rejectionsByJid: loadInitial(),
  setRejections: (jid, rejections) => {
    set((s) => {
      const existing = s.rejectionsByJid[jid]
      if (existing && rejectionsEqual(existing, rejections)) return s
      const next = { ...s.rejectionsByJid, [jid]: rejections }
      persist(next)
      return { rejectionsByJid: next }
    })
  },
  clearRejections: (jid) => {
    set((s) => {
      if (!(jid in s.rejectionsByJid)) return s
      const next = { ...s.rejectionsByJid }
      delete next[jid]
      persist(next)
      return { rejectionsByJid: next }
    })
  },
}))

export function recordCertRejections(jid: string, rejections: CertRejection[]): void {
  useCertRejectionStore.getState().setRejections(jid, rejections)
}

export function clearCertRejections(jid: string): void {
  useCertRejectionStore.getState().clearRejections(jid)
}

export function getCertRejections(jid: string): CertRejection[] | null {
  return useCertRejectionStore.getState().rejectionsByJid[jid] ?? null
}
