import type { Page } from '@playwright/test'

/**
 * Send the first native wheel after a fixture has installed its non-passive listener.
 *
 * A prevented-wheel fixture must actually cancel the input. WebKit can deliver an unpreventable
 * packet before rendering registers the new listener, so publish it across two animation frames
 * before dispatch. Keep this setup barrier outside gesture cadence and frame-bound measurements.
 */
export async function wheelAfterListenerRegistration(
  page: Page,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  if (page.context().browser()?.browserType().name() === 'webkit') {
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
  }
  await page.mouse.wheel(deltaX, deltaY)
}
