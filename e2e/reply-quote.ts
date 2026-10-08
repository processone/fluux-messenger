import { test, expect } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { useSettingsStore } from '../apps/fluux/src/stores/settingsStore'
import { bootDemo } from './harness/demoBoot'

for (const width of [390, 820]) {
  for (const kind of ['chat', 'room'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      for (const direction of ['ltr', 'rtl'] as const) {
        test(`${kind} ${theme} ${direction} at ${width}px: long reply quotes fit their bubbles`, async ({ page }) => {
          await page.setViewportSize({ width, height: 844 })
          await bootDemo(page, '/demo.html?tutorial=false')
          await page.evaluate(({ kind, theme, direction }) => {
            const demo = window as unknown as {
              __demoClient: DemoClient
              __settingsStore: typeof useSettingsStore
            }
            demo.__demoClient.stopAnimation()
            demo.__settingsStore.getState().setThemeMode(theme)
            document.documentElement.dir = direction
            const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
            for (const isOutgoing of [false, true]) {
              const id = `quote-overflow-${isOutgoing ? 'own' : 'other'}`
              const message = {
                id, stanzaId: undefined, originId: undefined,
                from: kind === 'chat' ? jid : `${jid}/Adrien`,
                timestamp: new Date(), isOutgoing,
                body: 'This reply stays inside its message bubble.',
                replyTo: {
                  id: `missing-original-${id}`, to: kind === 'chat' ? jid : `${jid}/Adrien`,
                  fallbackBody: `A long URL:\nhttps://example.invalid/${'unbroken'.repeat(80)}\nMore quoted context.`,
                },
              }
              if (kind === 'chat') {
                demo.__demoClient.emitSDK('chat:message', {
                  message: { ...message, type: 'chat', conversationId: jid }, isLiveArrival: true,
                })
              } else {
                demo.__demoClient.emitSDK('room:message', {
                  roomJid: jid,
                  message: { ...message, type: 'groupchat', roomJid: jid, nick: isOutgoing ? 'Mickael' : 'Adrien', occupantId: undefined },
                  isLiveArrival: true, incrementUnread: false,
                })
              }
            }
            location.hash = `#/${kind === 'chat' ? 'messages' : 'rooms'}/${encodeURIComponent(jid)}`
          }, { kind, theme, direction })

          for (const owner of ['other', 'own']) {
            const row = page.locator(`[data-message-id="quote-overflow-${owner}"][data-message-body]`)
            const quote = row.locator('.reply-quote-card')
            await expect(quote).toBeVisible({ timeout: 30_000 })
            await expect.poll(() => quote.evaluate(card => {
              const bubble = card.closest('[data-msg-chrome]')!.getBoundingClientRect()
              const rect = card.getBoundingClientRect()
              const preview = card.querySelector<HTMLElement>('.reply-quote-preview')!
              return {
                contained: rect.left >= bubble.left - 1 && rect.right <= bubble.right + 1,
                textFits: preview.scrollWidth <= preview.clientWidth + 1,
                heightBounded: preview.getBoundingClientRect().height <= 64,
              }
            })).toEqual({ contained: true, textFits: true, heightBounded: true })
          }
        })
      }
    }
  }
}
