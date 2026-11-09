import type { Page } from '@playwright/test'

/**
 * Publish a fixture's non-passive wheel listener before starting its timed action.
 *
 * WebKit can deliver an unpreventable packet before rendering registers a new listener.
 * Call after installation, before opening a media batch or a frame-bound measurement window;
 * the caller then starts the action and sends its native input without another setup barrier.
 */
export async function publishWheelListener(page: Page): Promise<void> {
  if (page.context().browser()?.browserType().name() === 'webkit') {
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
  }
}
