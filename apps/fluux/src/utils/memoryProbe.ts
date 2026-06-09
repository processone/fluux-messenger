import { getBlobUrlPoolSize, getAvatarResumeCount } from '@fluux/sdk'

/**
 * Opt-in memory / blob-pool probe.
 *
 * The avatar blob-URL leak class (orphaned `blob:` URLs on every SM resumption)
 * is invisible to React, to the render-loop detector, and to the resize monitor —
 * it only shows up as growing native WebKit memory. This probe makes it visible:
 * once enabled, it logs one `[MemProbe]` line every 30s (forwarded to fluux.log in
 * Tauri), so a tester can watch the avatar blob-pool size against the SM-resume
 * count. A flat pool size across many resumes confirms the leak class is gone.
 *
 * Off by default — enable with `localStorage['fluux:mem-probe'] = '1'`.
 */
const PROBE_INTERVAL_MS = 30_000
const FLAG_KEY = 'fluux:mem-probe'
const BYTES_PER_MB = 1024 * 1024

export function isMemoryProbeEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Used JS heap in whole MB, or null when the engine doesn't expose it.
 * `performance.memory` is Chromium-only — undefined on WebKit / WebKitGTK (the
 * Tauri webview on macOS/Linux), where the blob-pool size is the load-bearing signal.
 */
export function usedHeapMB(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return mem ? Math.round(mem.usedJSHeapSize / BYTES_PER_MB) : null
}

export function buildMemoryProbeLine(
  poolSize: number,
  heapMB: number | null,
  resumeCount: number
): string {
  const heap = heapMB == null ? 'n/a' : `${heapMB}MB`
  return `[MemProbe] avatarBlobPool=${poolSize} usedHeap=${heap} smResumes=${resumeCount}`
}

function sample(): void {
  console.info(buildMemoryProbeLine(getBlobUrlPoolSize(), usedHeapMB(), getAvatarResumeCount()))
}

/**
 * Start the probe. No-op (returns a no-op stop fn) unless the flag is set, so it is
 * safe to mount unconditionally. Logs one sample immediately, then every 30s.
 * @returns a stop function that cancels the interval.
 */
export function startMemoryProbe(): () => void {
  if (!isMemoryProbeEnabled()) return () => {}
  sample()
  const id = setInterval(sample, PROBE_INTERVAL_MS)
  return () => clearInterval(id)
}
