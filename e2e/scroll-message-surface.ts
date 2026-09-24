import { test, expect } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { useSettingsStore } from '../apps/fluux/src/stores/settingsStore'
import { bootDemo } from './harness/demoBoot'

// jsdom cannot observe subpixel gaps between independently positioned message rows.
for (const width of [1280, 390]) {
  for (const mode of ['light', 'dark'] as const) {
    for (const fontSize of [100, 125]) {
      test(`grouped preview surface at ${width}px, ${mode}, ${fontSize}% text`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await bootDemo(page, '/demo.html?tutorial=false&virt=1')
        await page.evaluate(({ mode, fontSize }) => {
          const demo = window as unknown as Window & {
            __demoClient: DemoClient
            __settingsStore: typeof useSettingsStore
          }
          demo.__demoClient.stopAnimation()
          demo.__settingsStore.getState().setThemeMode(mode)
          demo.__settingsStore.getState().setFontSize(fontSize)
          const conversationId = 'emma@fluux.chat'
          const preview = {
            url: 'https://gultsch.de/posts/breaking-up-with-google-play/',
            siteName: 'Daniel Gultsch',
            title: 'Breaking Up with Google Play: Why Conversations Is Now Free',
            description: 'Conversations is leaving Google Play. Learn more about the future of the app.',
          }
          const bodies = [
            'Plain group first',
            'Plain group continuation',
            `Conversations is going to leave the play store: ${preview.url}`,
            'We should publish Fluux there as well I guess',
            'A preview at the end of the group',
            'A standalone incoming preview',
          ]
          const now = Date.now()
          bodies.forEach((body, index) => {
            demo.__demoClient.emitSDK('chat:message', {
              message: {
                type: 'chat', id: `surface-${index}`, conversationId,
                stanzaId: undefined, originId: undefined,
                from: index === 5 ? conversationId : 'you@fluux.chat',
                body, isOutgoing: index !== 5, timestamp: new Date(now + index * 1000),
                ...([2, 4, 5].includes(index) ? { linkPreview: preview } : {}),
              },
              isLiveArrival: true,
            })
          })
          location.hash = '#/messages/emma%40fluux.chat'
        }, { mode, fontSize })

        const chrome = (index: number) => page.locator(`[data-message-id="surface-${index}"] [data-msg-chrome]`)
        await expect(chrome(5)).toBeAttached()
        await chrome(3).scrollIntoViewIfNeeded()
        // Both gaps and overlaps break a translucent group's continuous tint.
        // Allow one layout unit for browser arithmetic, never a visible half-pixel seam.
        for (let index = 0; index < 4; index++) {
          await expect.poll(async () => {
            const above = (await chrome(index).boundingBox())!
            const below = (await chrome(index + 1).boundingBox())!
            return Math.abs(below.y - (above.y + above.height))
          }).toBeLessThanOrEqual(1 / 64)
        }
        await expect(chrome(3)).toHaveAttribute('data-msg-chrome', 'cont')
        await expect(chrome(4)).toHaveClass(/message-own-tint-end/)
        await expect(chrome(5)).not.toHaveAttribute('data-msg-own')
        for (const index of [2, 4, 5]) {
          const content = (await chrome(index).boundingBox())!
          const card = (await chrome(index).getByRole('link', { name: /Daniel Gultsch Breaking Up/ }).boundingBox())!
          expect(card.x).toBeGreaterThanOrEqual(content.x)
          expect(card.x + card.width).toBeLessThanOrEqual(content.x + content.width + 1 / 64)
          expect(card.y + card.height).toBeLessThanOrEqual(content.y + content.height + 1 / 64)
        }
      })
    }
  }
}
