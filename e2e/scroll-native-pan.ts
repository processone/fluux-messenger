// Intent: FLM-276. Native autoscroll must not reverse visible reading progress as
// estimates and measured rows change. Reuses FLM-230's actual-demo seed and native journeys.
import { expect, test, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { chatStore, roomStore } from '@fluux/sdk/stores'
import type { useSettingsStore } from '../apps/fluux/src/stores/settingsStore'
import { bootDemo } from './harness/demoBoot'
import { waitForTopVisibleSettled } from './harness/scrollHarness'

type Kind = 'chat' | 'room'
type Demo = Window & {
  __demoClient: DemoClient
  __chatStore: typeof chatStore
  __roomStore: typeof roomStore
  __settingsStore: typeof useSettingsStore
}
const targetId = 'interaction-target'

async function arrive(page: Page, kind: Kind, ids: string[], own = false) {
  await page.evaluate(({ kind, ids, own }) => {
    const scope = window as unknown as Demo
    const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
    const firstTimestamp = Date.now() - ids.length
    for (const [index, id] of ids.entries()) {
      const message = {
        id, stanzaId: undefined, originId: undefined, occupantId: undefined,
        from: kind === 'chat' ? own ? 'you@fluux.chat' : jid : `${jid}/${own ? 'You' : 'Adrien'}`,
        body: own ? 'Let’s keep this message in place while choosing an action.' : 'A new update from the conversation.',
        timestamp: new Date(firstTimestamp + index), isOutgoing: own,
      }
      if (kind === 'chat') scope.__demoClient.emitSDK('chat:message', { message: { ...message, type: 'chat', conversationId: jid }, isLiveArrival: true })
      else scope.__demoClient.emitSDK('room:message', { roomJid: jid, message: { ...message, type: 'groupchat', roomJid: jid, nick: own ? 'You' : 'Adrien' }, isLiveArrival: true, incrementUnread: true })
    }
  }, { kind, ids, own })
}

const distance = (page: Page) => page.locator('[data-message-list]').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)

async function setup(page: Page, kind: Kind) {
  await bootDemo(page, '/demo.html?tutorial=false&virt=1')
  await page.mouse.move(0, 0)
  await page.evaluate(async kind => {
    const scope = window as unknown as Demo
    scope.__demoClient.stopAnimation()
    scope.__settingsStore.getState().setThemeMode('dark')
    scope.__settingsStore.getState().setMediaAutoDownload('always')
    const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
    if (kind === 'chat') await scope.__chatStore.getState().activateConversation(jid)
    else await scope.__roomStore.getState().activateRoom(jid)
    location.hash = `#/${kind === 'chat' ? 'messages' : 'rooms'}/${encodeURIComponent(jid)}`
  }, kind)
  await page.locator('[data-message-list]').waitFor()
  await arrive(page, kind, Array.from({ length: 45 }, (_, i) => `interaction-seed-${i}`))
  await arrive(page, kind, [targetId], true)
  await page.keyboard.press('End')
  const target = page.locator(`.message-row[data-message-id="${targetId}"]`)
  await expect(target).toBeInViewport()
  await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
  expect(await waitForTopVisibleSettled(page), 'the initial view must settle').not.toBeNull()
  return target
}

for (const kind of ['chat', 'room'] as const) {
  for (const mode of ['held', 'jitter-latched', 'middle-stopped'] as const) {
    test(`${kind}: ${mode} native upward pan keeps visible progress through remeasurement`, async ({ page }) => {
      const target = await setup(page, kind)
      await target.locator('[data-message-body]').hover()
      // Keep the same screen origin as the original main/interaction-hold comparison.
      const box = (await target.locator('[data-message-body]').boundingBox())!
      const x = box.x + 180, y = box.y + 12
      await arrive(page, kind, Array.from({ length: 12 }, (_, i) => `${mode}-${i}`))
      await page.mouse.move(x, y)
      await page.mouse.down({ button: 'middle' })
      await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
      expect(await waitForTopVisibleSettled(page), 'the released live edge must settle').not.toBeNull()
      if (mode !== 'held') {
        if (mode === 'jitter-latched') await page.mouse.move(x + 1, y)
        await page.mouse.up({ button: 'middle' })
      }
      const capture = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>('[data-message-list]')!
        const samples: { top: number; height: number; at: number; anchor: { id: string; order: number; top: number } | null }[] = []
        const inputs: { type: string; trusted: boolean; button: number }[] = []
        const onInput = (event: MouseEvent) => inputs.push({ type: event.type, trusted: event.isTrusted, button: event.button })
        document.addEventListener('mousemove', onInput, true)
        document.addEventListener('mouseup', onInput, true)
        document.addEventListener('mousedown', onInput, true)
        let frame = 0
        const tick = () => {
          const view = list.getBoundingClientRect()
          const anchors = [...list.querySelectorAll<HTMLElement>('.message-row')].map(row => {
            const rect = row.getBoundingClientRect()
            return { id: row.dataset.messageRowId!, order: Number(row.closest<HTMLElement>('[data-index]')?.dataset.index), top: rect.top - view.top, bottom: rect.bottom - view.top }
          }).filter(row => row.top >= -1 && row.bottom <= view.height + 1).sort((a, b) => a.top - b.top)
          samples.push({ top: list.scrollTop, height: list.scrollHeight, at: performance.now(), anchor: anchors[0] ?? null })
          frame = requestAnimationFrame(tick)
        }
        tick()
        ;(window as unknown as { stopNativePanCapture: () => unknown }).stopNativePanCapture = () => {
          cancelAnimationFrame(frame)
          document.removeEventListener('mousemove', onInput, true)
          document.removeEventListener('mouseup', onInput, true)
          document.removeEventListener('mousedown', onInput, true)
          return { samples, inputs }
        }
        return { top: list.scrollTop }
      })
      await page.mouse.move(x, y - 50, { steps: 5 })
      await page.evaluate(() => new Promise<void>(resolve => {
        let frames = 0
        const tick = () => ++frames >= 60 ? resolve() : requestAnimationFrame(tick)
        requestAnimationFrame(tick)
      }))
      const result = await page.evaluate(() => (window as unknown as {
        stopNativePanCapture: () => { samples: { top: number; height: number; at: number; anchor: { id: string; order: number; top: number } | null }[]; inputs: { type: string; trusted: boolean; button: number }[] }
      }).stopNativePanCapture())
      if (mode === 'held') await page.mouse.up({ button: 'middle' })
      else await page.mouse.click(x, y - 50, { button: mode === 'middle-stopped' ? 'middle' : 'left' })
      // Returning from the stop click does not drain the compositor's last native step.
      // Observe the stopped geometry before testing the next deliberate navigation.
      expect(await waitForTopVisibleSettled(page), 'native panning must stop before navigation').not.toBeNull()
      await test.info().attach('native-pan-frames', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
      expect(result.inputs.length).toBeGreaterThan(0)
      expect(result.inputs.every(input => input.trusted)).toBe(true)
      expect(result.samples.at(-1)!.top).toBeLessThan(capture.top - 10)
      for (const [index, sample] of result.samples.entries()) {
        expect(sample.anchor, 'a fully visible message anchors each frame').not.toBeNull()
        const previous = result.samples[index - 1]?.anchor
        if (!previous || !sample.anchor) continue
        expect(sample.anchor.order, 'an upward pan cannot return to a newer message').toBeLessThanOrEqual(previous.order)
        if (sample.anchor.id === previous.id) expect(sample.anchor.top, 'the same message cannot move against the pan').toBeGreaterThanOrEqual(previous.top - 1)
      }
      // Stop is not a stale positioning command: ordinary deliberate navigation still works.
      await page.keyboard.press('End')
      await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    })
  }
}
