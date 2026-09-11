import type { Page } from '@playwright/test'

/**
 * Publish committed scroll positions before taking a settled geometry snapshot.
 *
 * On an idle WebKit page, scrollTop and row rects can consistently reflect a requested position
 * instead of the committed one. Waiting longer, sampling read-only animation frames, or forcing
 * layout does not guarantee a paint; the next input can then publish the correction between
 * snapshots and make it look like a regression caused by that input. The paint probe below
 * forces a compositor round trip without changing the measured layout.
 *
 * Call after layout settlement, before both baseline and final snapshots. This publishes geometry;
 * it does not establish layout stability or replace an assertion's existing tolerance. Keep it out
 * of gesture cadence waits and frame-bound measurement windows, including those driven by
 * pinWindow.ts: its extra frames would change the timing those invariants measure.
 */
export async function syncEngineGeometry(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => {
    const probe = document.createElement('div')
    // One pixel, fixed, on top of everything and outside every box a suite measures, so it cannot
    // enter a measured layout and cannot receive events.
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;background:#000;pointer-events:none;z-index:2147483647'
    document.body.appendChild(probe)
    // Two frames: one to paint the probe, one for the engine to hand back what it committed.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        probe.remove()
        resolve()
      }),
    )
  }))
}
