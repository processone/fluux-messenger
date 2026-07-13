/**
 * Download progress tracker for the Tauri auto-updater.
 *
 * Accumulates the updater's `Started` / `Progress` / `Finished` events into a
 * single 0-100 progress value and *throttles* the frequent `Progress` events so
 * the consumer re-renders at most once per `minIntervalMs`.
 *
 * Why throttle: on a fast connection the updater emits a `Progress` event per
 * network chunk — hundreds per second. The previous code called `setState` on
 * every one, which (because the update state lives in `App`) re-rendered the
 * whole component tree at chunk frequency and tripped the render-loop detector,
 * replacing the UI with the "render loop detected" error screen mid-download.
 * See issue #994.
 *
 * `Started` (0%) and `Finished` (100%) are terminal states the UI must always
 * reflect, so they bypass the throttle. Sub-percent `Progress` deltas are
 * invisible anyway (the bar shows `Math.round(progress)`), so dropping the
 * throttled ones costs nothing visually.
 */

export type UpdaterDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

export interface DownloadProgressTracker {
  /**
   * Fold one updater event into the running progress. Returns the new 0-100
   * progress value to flush to state, or `null` when the event was throttled
   * (or carried no visible change) and no re-render is warranted.
   */
  handle(event: UpdaterDownloadEvent): number | null
}

export function createDownloadProgressTracker(
  minIntervalMs: number,
  now: () => number = Date.now,
): DownloadProgressTracker {
  let contentLength = 0
  let progress = 0
  let lastEmit = 0

  return {
    handle(event) {
      switch (event.event) {
        case 'Started':
          contentLength = event.data.contentLength ?? 0
          progress = 0
          lastEmit = now()
          return 0

        case 'Progress': {
          // Without a known total we can't compute a fraction — mirror the old
          // behavior of not touching state until `Started` supplied the length.
          if (contentLength <= 0) return null
          progress = Math.min(progress + (event.data.chunkLength / contentLength) * 100, 99)
          const t = now()
          if (t - lastEmit >= minIntervalMs) {
            lastEmit = t
            return progress
          }
          return null
        }

        case 'Finished':
          progress = 100
          return 100
      }
    },
  }
}
