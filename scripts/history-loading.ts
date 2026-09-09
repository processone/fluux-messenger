import { test, expect, devices } from '@playwright/test'
import { bootDemo } from './e2e/demoBoot'
import type { chatStore, roomStore } from '@fluux/sdk'

type DemoWindow = Window & {
  __chatStore: typeof chatStore
  __roomStore: typeof roomStore
  __releaseHistoryRead?: () => void
  __historyOpening?: Promise<void>
}

test.use({
  viewport: devices['iPhone 13'].viewport,
  userAgent: devices['iPhone 13'].userAgent,
  isMobile: true,
  hasTouch: true,
})

for (const kind of ['chat', 'room'] as const) {
  for (const action of ['button', 'browser', 'finish', 'tab'] as const) {
    test(`${kind}: slow cache read handles ${action}`, async ({ page }, testInfo) => {
      await bootDemo(page, '/demo.html?tutorial=false')
      await page.locator(`[data-nav="${kind === 'chat' ? 'messages' : 'rooms'}"]`).click()
      const sidebar = page.getByTestId('sidebar-pane')
      await expect(sidebar).toBeVisible()

      // Hold the actual SDK activation at its cache boundary; retain the real
      // token cancellation, routing, store subscriptions and mobile layout.
      await page.evaluate((entity) => {
        const w = window as unknown as DemoWindow
        let release: () => void = () => {}
        const gate = new Promise<void>(resolve => { release = resolve })
        if (entity === 'chat') {
          const read = w.__chatStore.getState().loadMessagesFromCache
          const activate = w.__chatStore.getState().activateConversation
          w.__chatStore.setState({
            loadMessagesFromCache: async (...args) => { await gate; return read(...args) },
            activateConversation: id => {
              const opening = activate(id)
              if (id) w.__historyOpening = opening
              return opening
            },
          })
          w.__releaseHistoryRead = () => { w.__chatStore.setState({ loadMessagesFromCache: read, activateConversation: activate }); release() }
        } else {
          const read = w.__roomStore.getState().loadMessagesFromCache
          const activate = w.__roomStore.getState().activateRoom
          w.__roomStore.setState({
            loadMessagesFromCache: async (...args) => { await gate; return read(...args) },
            activateRoom: id => {
              const opening = activate(id)
              if (id) w.__historyOpening = opening
              return opening
            },
          })
          w.__releaseHistoryRead = () => { w.__roomStore.setState({ loadMessagesFromCache: read, activateRoom: activate }); release() }
        }
      }, kind)

      await sidebar.getByText(kind === 'chat' ? 'Ava Martinez' : 'Team Chat', { exact: true }).click()
      const main = page.getByRole('main')
      await expect(main.getByRole('status')).toHaveText('Loading messages...')
      await expect(sidebar).toBeHidden()
      await page.screenshot({ path: testInfo.outputPath('history-loading.png') })

      if (action === 'button') await main.getByRole('button', { name: 'Back', exact: true }).click()
      if (action === 'browser') await page.goBack()
      if (action === 'tab') {
        // The navigation rail shares the hidden sidebar on phones. A wider
        // viewport exposes it while the conversation is still loading.
        await page.setViewportSize({ width: 1024, height: 844 })
        await page.locator('[data-nav="contacts"]').click()
      }
      if (action !== 'finish') await expect(sidebar).toBeVisible()

      await page.evaluate(async () => {
        const w = window as unknown as DemoWindow
        w.__releaseHistoryRead?.()
        await w.__historyOpening
      })
      await expect.poll(() => page.evaluate((entity) => {
        const w = window as unknown as DemoWindow
        const state = entity === 'chat' ? w.__chatStore.getState() : w.__roomStore.getState()
        return state.activationPending
      }, kind)).toBe(false)
      if (action === 'finish') {
        await expect(main.getByRole('status')).toBeHidden()
        await expect(main.locator('[data-message-id]').first()).toBeVisible()
      } else {
        if (action === 'tab') await page.setViewportSize(devices['iPhone 13'].viewport)
        await expect(sidebar).toBeVisible()
        await expect(main).toBeHidden()
      }
    })
  }
}
