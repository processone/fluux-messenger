// Intent: FLM-276. Native autoscroll must not reverse visible reading progress as
// estimates and measured rows change. Reuses FLM-230's actual-demo seed and native journeys.
import { expect, test, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { chatStore, roomStore } from '@fluux/sdk/stores'
import type { useSettingsStore } from '../apps/fluux/src/stores/settingsStore'
import { bootDemo } from './harness/demoBoot'
import { waitForTopVisibleSettled } from './harness/scrollHarness'
import capturedMeasurements from '../apps/fluux/src/components/conversation/__fixtures__/nativePanMeasurements.json' with { type: 'json' }

type Kind = 'chat' | 'room'
type Demo = Window & {
  __demoClient: DemoClient
  __chatStore: typeof chatStore
  __roomStore: typeof roomStore
  __settingsStore: typeof useSettingsStore
}
const targetId = 'interaction-target'
type Sample = {
  at: number; top: number; height: number; client: number
  anchor: { id: string; order: number; top: number; bottom: number } | null
}
type ScrollReading = { at: number; from: number; top: number; trusted: boolean }
type Measurement = {
  key: string; oldSize: number | null; size: number; cached: boolean; direction: string | null
  target: boolean; above: boolean; frame: number; layoutFrame: number | null
  before: Sample; after: Sample | null; layout: Sample | null
  nativeScroll: ScrollReading | null
}
type Observation = {
  start: Sample | null; samples: Sample[]
  inputs: { at: number; type: string; trusted: boolean; x: number; y: number; buttons: number }[]
  scrolls: ScrollReading[]; measurements: Measurement[]; forced: Measurement | null
}
type Capture = {
  read: () => { cached: { index: number; size: number | null; mounted: boolean }[]; observed: number }
  begin: () => Sample
  stop: () => Observation
}
type CaptureWindow = Window & { nativePanCapture: Capture }

// Observe the actual library call, including its final direction after the adapter's live-offset
// synchronization. Forward the original call exactly once; never derive caches or alter its state.
function installCapture(indices: number[]) {
  const list = document.querySelector<HTMLElement>('[data-message-list]')!
  type Core = {
    scrollElement: HTMLElement; scrollOffset: number | null; scrollDirection: string | null
    resizeItem: (index: number, size: number) => void
    itemSizeCache: Map<unknown, number>
    measurementsCache: { start: number; size: number }[]
    options: { getItemKey: (index: number) => unknown }
  }
  type Hook = { memoizedState: unknown; next?: Hook }
  type Fiber = { memoizedState?: Hook; return?: Fiber }
  const fiberKey = Object.keys(list).find(key => key.startsWith('__reactFiber$'))
  let fiber = fiberKey ? (list as unknown as Record<string, Fiber>)[fiberKey] : undefined
  let found: Core | undefined
  for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
    let hook = fiber.memoizedState
    for (let n = 0; hook && typeof hook === 'object' && 'memoizedState' in hook && n < 500; n++, hook = hook.next) {
      const value = hook.memoizedState as Partial<Core> | null
      if (value?.scrollElement === list && typeof value.resizeItem === 'function' && value.itemSizeCache instanceof Map) found = value as Core
    }
  }
  if (!found) throw new Error('Actual virtualizer measurement instance not found; no inferred attribution')
  const core = found
  const keys = new Set(indices.map(index => core.options.getItemKey(index)))
  const sample = (): Sample => {
    const view = list.getBoundingClientRect()
    const anchors = [...list.querySelectorAll<HTMLElement>('.message-row')].map(row => {
      const rect = row.getBoundingClientRect()
      return { id: row.dataset.messageRowId!, order: Number(row.closest<HTMLElement>('[data-index]')?.dataset.index), top: rect.top - view.top, bottom: rect.bottom - view.top }
    }).filter(row => row.top >= -1 && row.bottom <= view.height + 1).sort((a, b) => a.top - b.top)
    return { at: performance.now(), top: list.scrollTop, height: list.scrollHeight, client: list.clientHeight, anchor: anchors[0] ?? null }
  }
  const data: Observation = { start: null, samples: [], inputs: [], scrolls: [], measurements: [], forced: null }
  let active = false, frame = 0, frameNumber = 0, lastTop = list.scrollTop
  const layout = () => {
    for (const reading of data.measurements) {
      if (reading.target && reading.oldSize !== null && reading.size < reading.oldSize && !reading.layout &&
        list.scrollHeight <= reading.before.height - (reading.oldSize - reading.size) + 1) {
        reading.layout = sample()
        reading.layoutFrame = frameNumber
      }
    }
  }
  const mutations = new MutationObserver(layout)
  mutations.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
  const original = core.resizeItem
  core.resizeItem = (itemIndex, size) => {
    const itemKey = core.options.getItemKey(itemIndex)
    const oldSize = core.itemSizeCache.get(itemKey)
    const item = core.measurementsCache[itemIndex]
    if (!active || (oldSize ?? item?.size) === size) return original.call(core, itemIndex, size)
    const reading: Measurement = {
      key: String(itemKey), oldSize: oldSize ?? item?.size ?? null, size, cached: core.itemSizeCache.has(itemKey),
      target: keys.has(itemKey), frame: frameNumber, layoutFrame: null,
      direction: core.scrollDirection,
      above: oldSize !== undefined && item !== undefined && item.start + oldSize <= (core.scrollOffset ?? list.scrollTop),
      before: sample(), after: null, layout: null, nativeScroll: data.scrolls.at(-1) ?? null,
    }
    data.measurements.push(reading)
    if (reading.target && oldSize !== undefined && size < oldSize && reading.direction === 'backward' && !data.forced) data.forced = reading
    try { return original.call(core, itemIndex, size) }
    finally { reading.after = sample(); layout() }
  }
  const onScroll = (event: Event) => {
    if (!active) return
    const top = list.scrollTop
    data.scrolls.push({ at: performance.now(), from: lastTop, top, trusted: event.isTrusted })
    lastTop = top
  }
  const onInput = (event: MouseEvent) => {
    if (active) data.inputs.push({ at: performance.now(), type: event.type, trusted: event.isTrusted, x: event.clientX, y: event.clientY, buttons: event.buttons })
  }
  // Capture before the virtualizer's ordinary scroll listener performs its synchronous render.
  list.addEventListener('scroll', onScroll, true)
  document.addEventListener('mousemove', onInput, true)
  const tick = () => { if (active) { frameNumber++; data.samples.push(sample()); layout(); frame = requestAnimationFrame(tick) } }
  ;(window as unknown as CaptureWindow).nativePanCapture = {
    read: () => ({
      cached: indices.map(index => ({ index, size: core.itemSizeCache.get(core.options.getItemKey(index)) ?? null,
        mounted: list.querySelector(`[data-index="${index}"]`)?.isConnected === true })),
      observed: data.measurements.filter(row => row.target && row.cached && row.oldSize !== null && row.size < row.oldSize && row.direction === 'backward' && row.layout !== null).length,
    }),
    begin: () => { data.start = sample(); lastTop = list.scrollTop; active = true; tick(); return data.start },
    stop: () => {
      active = false; cancelAnimationFrame(frame); mutations.disconnect(); core.resizeItem = original
      list.removeEventListener('scroll', onScroll, true); document.removeEventListener('mousemove', onInput, true)
      return data
    },
  }
}

function expectProgress(before: Sample, after: Sample, context: string) {
  expect(before.anchor, `${context}: an initial visible message anchors the comparison`).not.toBeNull()
  expect(after.anchor, `${context}: a final visible message anchors the comparison`).not.toBeNull()
  expect(after.anchor!.order, `${context}: cannot return to a newer message`).toBeLessThanOrEqual(before.anchor!.order)
  if (after.anchor!.id === before.anchor!.id) expect(after.anchor!.top, `${context}: the same message cannot move against the pan`).toBeGreaterThanOrEqual(before.anchor!.top - 1)
}

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
      const box = (await target.locator('[data-message-body]').boundingBox())!
      const x = box.x + 180, y = box.y + 12
      await arrive(page, kind, Array.from({ length: 12 }, (_, i) => `${mode}-${i}`))
      await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
      expect(await waitForTopVisibleSettled(page), 'arrivals must settle before warming the cached row').not.toBeNull()
      const measurement = capturedMeasurements.find(fixture => fixture.kind === kind)!.measurement
      const shrink = measurement.oldSize - measurement.size
      const warm = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>('[data-message-list]')!
        const view = list.getBoundingClientRect()
        const rows = [...list.querySelectorAll<HTMLElement>('[data-index]')].filter(node =>
          node.querySelector('.message-row') && node.getBoundingClientRect().bottom < view.top - view.height / 4,
        ).slice(0, 6)
        if (rows.length !== 6) throw new Error('Six mounted overscan messages are required for cached native windowing')
        return rows.map(row => ({ index: Number(row.dataset.index), height: row.getBoundingClientRect().height }))
      })
      await page.evaluate(installCapture, warm.map(row => row.index))
      await page.evaluate(({ rows, delta }) => {
        for (const row of rows) document.querySelector<HTMLElement>(`[data-message-list] [data-index="${row.index}"]`)!.style.minHeight = `${row.height + delta}px`
      }, { rows: warm, delta: shrink })
      await expect.poll(() => page.evaluate(() => (window as unknown as CaptureWindow).nativePanCapture.read().cached))
        .toEqual(warm.map(row => ({ index: row.index, size: row.height + shrink, mounted: true })))
      // One continuous journey crosses several known cached rows. Offset synchronization may
      // clear a particular measurement's direction; keep it as a control, never backward proof.
      await arrive(page, kind, Array.from({ length: 12 }, (_, i) => `${mode}-window-${i}`))
      await expect.poll(() => page.evaluate(() => (window as unknown as CaptureWindow).nativePanCapture.read().cached))
        .toEqual(warm.map(row => ({ index: row.index, size: row.height + shrink, mounted: false })))
      await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
      expect(await waitForTopVisibleSettled(page), 'the live edge must settle before native input').not.toBeNull()
      await page.mouse.move(x, y)
      await page.mouse.down({ button: 'middle' })
      if (mode !== 'held') {
        if (mode === 'jitter-latched') await page.mouse.move(x + 1, y)
        await page.mouse.up({ button: 'middle' })
      }
      const start = await page.evaluate(() => (window as unknown as CaptureWindow).nativePanCapture.begin())
      // Keep moving backward. Native windowing remounts the same cached row at its natural
      // smaller height; the probe records the real measurement decision, not a paused surrogate.
      await page.mouse.move(x, y - 20, { steps: 5 })
      await page.waitForFunction(() => (window as unknown as CaptureWindow).nativePanCapture.read().observed >= 1, undefined, { polling: 'raf' })
      await page.evaluate(() => new Promise<void>(resolve => {
        let frames = 0
        const tick = () => ++frames >= 60 ? resolve() : requestAnimationFrame(tick)
        requestAnimationFrame(tick)
      }))
      const result = await page.evaluate(() => (window as unknown as CaptureWindow).nativePanCapture.stop())
      if (mode === 'held') await page.mouse.up({ button: 'middle' })
      else await page.mouse.click(x, y - 20, { button: mode === 'middle-stopped' ? 'middle' : 'left' })
      expect(await waitForTopVisibleSettled(page), 'native panning must stop before navigation').not.toBeNull()
      await test.info().attach('native-pan-frames', { body: JSON.stringify({ ...result, warm, shrink }, null, 2), contentType: 'application/json' })
      const forced = result.measurements.filter(row => row.target && row.cached && row.oldSize !== null && row.size < row.oldSize && row.direction === 'backward')
      expect(forced.length, 'a programmed cached shrink must land during actual backward movement').toBeGreaterThan(0)
      for (const reading of forced) {
        expect(reading.oldSize! - reading.size, 'the captured shrink delta must reach the real library').toBe(shrink)
        expect(reading.above, 'the cached row must be entirely above the reader').toBe(true)
        expect(reading.nativeScroll?.trusted, 'a trusted native scroll drives the remount').toBe(true)
        expect(reading.nativeScroll!.top).toBeLessThan(reading.nativeScroll!.from)
        expect(reading.before.top, 'the shrink must not be absorbed by live-edge clamping').toBeLessThan(start.top - shrink)
        expect(reading.layout, 'the forced row must change the real scroll extent').not.toBeNull()
        expect(reading.layoutFrame! - reading.frame, 'attribute the actual resize layout, not a later event').toBeLessThanOrEqual(2)
        const intervening = result.measurements.filter(other => other.before.at >= reading.before.at && other.before.at <= reading.layout!.at && other.oldSize !== null && other.oldSize !== other.size)
        expect(intervening.every(other => other.target), 'an unrelated resize cannot supply the forced result').toBe(true)
        expectProgress(reading.before, reading.layout!, 'forced cached-row shrink')
      }
      expect(result.inputs.length).toBeGreaterThan(0)
      expect(result.inputs.every(input => input.trusted)).toBe(true)
      expect(result.samples.at(-1)!.top).toBeLessThan(start.top - 10)
      for (let i = 1; i < result.samples.length; i++) expectProgress(result.samples[i - 1], result.samples[i], 'continuous native pan')
      await page.keyboard.press('End')
      await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    })
  }
}
