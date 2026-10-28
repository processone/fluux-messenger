import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { chatStore, roomStore } from '@fluux/sdk/stores'
import type { useSettingsStore } from '../../apps/fluux/src/stores/settingsStore'
import { bootDemo } from './demoBoot'

export type ConversationKind = 'chat' | 'room'
type Demo = Window & {
  __demoClient: DemoClient
  __chatStore: typeof chatStore
  __roomStore: typeof roomStore
  __settingsStore: typeof useSettingsStore
}
export const TARGET = 'interaction-target'
export const jidFor = (kind: ConversationKind) => kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'

export async function arrive(page: Page, kind: ConversationKind, ids: string[], own = false) {
  await page.evaluate(({ kind, ids, own }) => {
    const scope = window as Demo
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

export async function setupInteraction(page: Page, kind: ConversationKind, restingPointer = false) {
  if (process.env.FLUUX_INTERACTION_TRACE) page.on('console', message => {
    if (/\[Scroll\]|\[Interaction\]/.test(message.text())) console.log(message.text())
  })
  await bootDemo(page, '/demo.html?tutorial=false&virt=1')
  if (process.env.FLUUX_INTERACTION_TRACE) await page.evaluate(() => (window as any).__fluuxScrollDebug?.(true))
  await page.mouse.move(restingPointer ? 500 : 0, restingPointer ? 300 : 0)
  await page.evaluate(async kind => {
    const scope = window as Demo
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
  await arrive(page, kind, [TARGET], true)
  await page.keyboard.press('End')
  const row = page.locator(`.message-row[data-message-id="${TARGET}"]`)
  await expect(row).toBeInViewport()
  await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
  await stableFrames(page, TARGET)
  return { row, body: row.locator('[data-message-body]'), list: page.locator('[data-message-list]') }
}

export async function distance(page: Page) {
  return page.locator('[data-message-list]').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
}

/** Stable geometry is measured across browser frames, not inferred from a delay. */
export async function stableFrames(page: Page, targetId: string, count = 8) {
  return page.evaluate(({ targetId, count }) => new Promise<{ row: number; controls: { label: string; x: number; y: number; width: number; height: number }[] }[]>((resolve, reject) => {
    const samples: { row: number; controls: { label: string; x: number; y: number; width: number; height: number }[] }[] = []
    let frames = 0
    const tick = () => {
      const row = document.querySelector(`.message-row[data-message-id="${CSS.escape(targetId)}"] [data-message-body]`)
      if (!row) return reject(new Error('interaction target unmounted'))
      const sample = {
        row: row.getBoundingClientRect().top,
        controls: [...row.querySelectorAll('[data-message-toolbar] button, [data-message-panel]')].map(element => {
          const { x, y, width, height } = element.getBoundingClientRect()
          return { label: element.getAttribute('aria-label') ?? element.textContent ?? '', x, y, width, height }
        }),
      }
      const previous = samples.at(-1)
      if (previous && (Math.abs(previous.row - sample.row) > 0.5 || JSON.stringify(previous.controls) !== JSON.stringify(sample.controls))) samples.length = 0
      samples.push(sample)
      if (samples.length >= count) resolve(samples)
      else if (++frames > 240) reject(new Error('target geometry did not settle'))
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }), { targetId, count })
}

export async function measureDuring(page: Page, targetId: string, action: () => Promise<unknown>) {
  await page.evaluate(targetId => {
    const scope = window as Window & { __holdSamples?: unknown[]; __holdFrame?: number }
    scope.__holdSamples = []
    const tick = () => {
      const row = document.querySelector(`.message-row[data-message-id="${CSS.escape(targetId)}"] [data-message-body]`)
      const box = (element: Element) => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return { x, y, width, height }
      }
      scope.__holdSamples!.push({ row: row ? box(row) : null, controls: row ? [...row.querySelectorAll('[data-message-toolbar] button, [data-message-panel]')].map(box) : [] })
      scope.__holdFrame = requestAnimationFrame(tick)
    }
    tick()
  }, targetId)
  try { await action(); await stableFrames(page, targetId) }
  finally {
    await page.evaluate(() => { const scope = window as Window & { __holdFrame?: number }; cancelAnimationFrame(scope.__holdFrame!) })
  }
  const samples = await page.evaluate(() => (window as Window & { __holdSamples: { row: { x: number; y: number; width: number; height: number } | null; controls: { x: number; y: number; width: number; height: number }[] }[] }).__holdSamples)
  await keepJson('all-interaction-frame-samples', samples)
  expect(samples.length).toBeGreaterThan(2)
  const first = samples[0]
  for (const sample of samples) {
    expect(sample.row, 'original message must remain mounted').not.toBeNull()
    expect(Math.abs(sample.row!.y - first.row!.y), 'row top drift while interacting').toBeLessThanOrEqual(1)
    expect(sample.controls.length, 'action slots must not reflow').toBe(first.controls.length)
    sample.controls.forEach((box, i) => {
      for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(box[key] - first.controls[i][key]), `control ${i} ${key} drift`).toBeLessThanOrEqual(1)
    })
  }
  return samples
}

/** Keep passing observations as files too: the list reporter does not retain attachment bodies. */
export async function keepJson(name: string, value: unknown) {
  const path = test.info().outputPath(`${name}.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
  await test.info().attach(name, { path, contentType: 'application/json' })
}

export async function waitForActions(page: Page, id = TARGET) {
  const toolbar = page.locator(`.message-row[data-message-id="${id}"] [data-message-toolbar]`)
  await expect(toolbar).toHaveClass(/opacity-100/)
  await expect(toolbar).toHaveCSS('opacity', '1')
  await stableFrames(page, id)
}
