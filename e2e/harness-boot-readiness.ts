import { expect, test } from '@playwright/test'
import { bootDemo, reloadDemo } from './harness/demoBoot'

test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })

/**
 * The boot's readiness contract (harness/demoBoot.ts): once it returns, the shell's own
 * startup navigation is over, so the next route a test sets is final.
 *
 * After a reload the shell restores the view saved in session storage, from a mount effect
 * that runs after the shell paints. A route set between the paint and that effect is
 * replaced. This sets a route at the very moment the demo reports the shell settled, which
 * is the earliest a test can act, and requires every startup navigation to come before it.
 */
test('a route set the moment the reloaded shell settles is not replaced by the view restore', async ({ page }) => {
  await bootDemo(page, '/demo.html?tutorial=false')
  // The startup auto-select opens a conversation, and the shell saves it as the view to restore.
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage)
    .filter(key => key.startsWith('xmpp-view-state'))
    .map(key => JSON.parse(sessionStorage.getItem(key)!).activeConversationId as string | null)
    .find(Boolean) ?? null)).not.toBeNull()

  await page.addInitScript(() => {
    const order: string[] = []
    ;(window as Window & { __bootOrder?: string[] }).__bootOrder = order
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method].bind(history)
      history[method] = (...args: Parameters<History['pushState']>) => {
        original(...args)
        order.push(`${method} ${location.hash}`)
      }
    }
    let settled: boolean | undefined
    Object.defineProperty(window, '__fluuxShellSettled', {
      configurable: true,
      get: () => settled,
      set: (value: boolean) => {
        settled = value
        if (value !== true) return
        order.push('settled')
        location.hash = '/settings/notifications'
      },
    })
  })
  await reloadDemo(page)

  await expect(page.getByRole('heading', { name: 'Notifications', level: 2 })).toBeVisible()
  expect(await page.evaluate(() => location.hash)).toBe('#/settings/notifications')
  const order = await page.evaluate(() => (window as Window & { __bootOrder?: string[] }).__bootOrder ?? [])
  const settledAt = order.indexOf('settled')
  expect(settledAt, `the demo reported the shell settled: ${order.join(', ')}`).toBeGreaterThanOrEqual(0)
  expect(order.slice(0, settledAt).some(entry => entry.startsWith('replaceState #/messages/')),
    `the view restore reopened the saved conversation before the shell settled: ${order.join(', ')}`).toBe(true)
  expect(order.slice(settledAt + 1), 'no startup navigation after the shell settled').toEqual([])
})
