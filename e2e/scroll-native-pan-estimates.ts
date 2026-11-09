// Intent: FLM-311. Native autoscroll must not reverse visible reading progress when the row
// metrics behind unmeasured estimates are resampled: the width sampled from own hug-width bubbles
// alone giving way to the full content width, or replacing it across a run of own messages, and a
// chrome correction once a plain continuation row first mounts.
import { expect, test, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { chatStore, roomStore } from '@fluux/sdk/stores'
import type { useSettingsStore } from '../apps/fluux/src/stores/settingsStore'
import { bootDemo } from './harness/demoBoot'
import { expectContinuity, expectProgress, FRAME_GAP_MS, type PanSample } from './harness/nativePan'
import { waitForTopVisibleSettled } from './harness/scrollHarness'

type Kind = 'chat' | 'room'
type Trigger = 'own-latest' | 'own-run' | 'chrome'
type Demo = Window & {
  __demoClient: DemoClient
  __chatStore: typeof chatStore
  __roomStore: typeof roomStore
  __settingsStore: typeof useSettingsStore
}
type Metrics = { contentWidthPx: number; header: number; continuation: number }
type Refresh = { at: number; direction: string | null; top: number; metrics: Metrics; before: PanSample }
type Scroll = { at: number; from: number; top: number; trusted: boolean }
type Observation = {
  start: PanSample; initial: Metrics; samples: PanSample[]; refreshes: Refresh[]
  inputs: { at: number; trusted: boolean }[]
  scrolls: Scroll[]
}
type Capture = { read: () => { refreshes: Refresh[]; top: number }; begin: () => Observation; stop: () => Observation }
type CaptureWindow = Window & { estimatePanCapture: Capture }

const LONG = 'Older context that wraps across several lines at the full reading width, so its estimated height depends on the sampled content width. '

// History whose metric the pan, not the latest window, recalibrates:
// - own-latest: the latest window holds only own hug-width bubbles, so the sampled width is their
//   lower bound until an older incoming row mounts;
// - own-run: the latest window samples the full width, a longer run of own bubbles narrows it,
//   and the older incoming rows restore it;
// - chrome: the latest window holds only rows with a sender header, so the continuation chrome
//   keeps its fallback until a plain continuation row mounts.
function history(trigger: Trigger) {
  const rows: { body: string; own: boolean; minutes: number }[] = []
  if (trigger !== 'chrome') {
    const own = trigger === 'own-latest' ? 50 : 90
    for (let i = 0; i < 80; i++) rows.push({ body: `${i} ${LONG.repeat(2)}`, own: false, minutes: i })
    for (let i = 0; i < own; i++) rows.push({ body: `ok ${i}`, own: true, minutes: 100 + i })
    if (trigger === 'own-run') for (let i = 0; i < 12; i++) rows.push({ body: `Latest update ${i}`, own: false, minutes: 200 + i })
  } else {
    for (let i = 0; i < 120; i++) rows.push({ body: `Continuation line ${i} that stays on one line.`, own: false, minutes: i / 6 })
    for (let i = 0; i < 24; i++) {
      rows.push({ body: `Header row ${i}`, own: false, minutes: 60 + i * 2 })
      rows.push({ body: `Reply ${i}`, own: true, minutes: 61 + i * 2 })
    }
  }
  return rows
}

async function open(page: Page, kind: Kind, trigger: Trigger) {
  await bootDemo(page, '/demo.html?tutorial=false&virt=1')
  await page.mouse.move(0, 0)
  const rows = history(trigger)
  await page.evaluate(async ({ kind, trigger, rows }) => {
    const scope = window as unknown as Demo
    const client = scope.__demoClient
    client.stopAnimation()
    scope.__settingsStore.getState().setThemeMode('dark')
    const jid = kind === 'chat' ? `estimates-${trigger}@fluux.chat` : `estimates-${trigger}@conference.fluux.chat`
    if (kind === 'chat') {
      client.emitSDK('chat:conversation', { conversation: { id: jid, name: 'Estimates', type: 'chat', unreadCount: 0 } })
    } else {
      const base = scope.__roomStore.getState().rooms.get('team@conference.fluux.chat')
      if (!base) throw new Error('demo room missing')
      client.emitSDK('room:added', { room: { ...base, jid, name: 'Estimates', unreadCount: 0, mentionsCount: 0 } })
    }
    const t0 = Date.now() - 24 * 60 * 60_000
    for (const [index, row] of rows.entries()) {
      const id = `${trigger}-${index}`
      const timestamp = new Date(t0 + row.minutes * 60_000)
      if (kind === 'chat') {
        client.emitSDK('chat:message', { message: { id, stanzaId: undefined, originId: undefined, conversationId: jid, type: 'chat',
          from: row.own ? 'you@fluux.chat' : jid, body: row.body, timestamp, isOutgoing: row.own }, isLiveArrival: false })
      } else {
        const nick = row.own ? 'You' : 'Adrien'
        client.emitSDK('room:message', { roomJid: jid, message: { type: 'groupchat', id, stanzaId: `sid-${id}`, originId: undefined, occupantId: undefined, roomJid: jid,
          from: `${jid}/${nick}`, nick, body: row.body, timestamp, isOutgoing: row.own }, isLiveArrival: false, incrementUnread: false })
      }
    }
    if (kind === 'chat') await scope.__chatStore.getState().activateConversation(jid)
    else await scope.__roomStore.getState().activateRoom(jid)
    location.hash = `#/${kind === 'chat' ? 'messages' : 'rooms'}/${encodeURIComponent(jid)}`
  }, { kind, trigger, rows })
  const list = page.locator('[data-message-list]')
  await list.waitFor()
  await expect(list.locator('.message-row').last()).toContainText(rows.at(-1)!.body)
  await expect.poll(() => list.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1)
  expect(await waitForTopVisibleSettled(page), 'the latest messages must settle before native input').not.toBeNull()
}

// Observe the actual virtualizer and the row metrics it estimates from; forward every call
// unchanged. A refresh is the adapter replacing the key function for the same rows.
function installCapture(trigger: Trigger) {
  const list = document.querySelector<HTMLElement>('[data-message-list]')!
  type Options = { count: number; getItemKey: (index: number) => unknown }
  type Core = { scrollElement: HTMLElement; scrollDirection: string | null; options: Options
    resizeItem: unknown; itemSizeCache: unknown; setOptions: (options: Options) => void }
  type MetricsRef = { current: { contentWidthPx: number; chrome: { header: number; continuation: number }; fontSpec: unknown } }
  type Hook = { memoizedState: unknown; next?: Hook }
  type Fiber = { memoizedState?: Hook; return?: Fiber }
  const fiberKey = Object.keys(list).find(key => key.startsWith('__reactFiber$'))
  let fiber = fiberKey ? (list as unknown as Record<string, Fiber>)[fiberKey] : undefined
  let core: Core | undefined
  let metrics: MetricsRef | undefined
  for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
    let hook = fiber.memoizedState
    for (let n = 0; hook && typeof hook === 'object' && 'memoizedState' in hook && n < 500; n++, hook = hook.next) {
      const value = hook.memoizedState as Partial<Core> & Partial<MetricsRef> | null
      if (value?.scrollElement === list && typeof value.resizeItem === 'function' && value.itemSizeCache instanceof Map) core = value as Core
      const current = value?.current as MetricsRef['current'] | undefined
      if (current && typeof current.contentWidthPx === 'number' && current.chrome && current.fontSpec) metrics = value as MetricsRef
    }
  }
  if (!core || !metrics) throw new Error('Actual virtualizer or row metrics not found; no inferred attribution')
  const lib = core, rowMetrics = metrics
  const readMetrics = () => ({ contentWidthPx: rowMetrics.current.contentWidthPx,
    header: rowMetrics.current.chrome.header, continuation: rowMetrics.current.chrome.continuation })
  const sample = (): PanSample => {
    const view = list.getBoundingClientRect()
    const anchors = [...list.querySelectorAll<HTMLElement>('.message-row')].map(row => {
      const rect = row.getBoundingClientRect()
      return { id: row.dataset.messageRowId!, order: Number(row.closest<HTMLElement>('[data-index]')?.dataset.index), top: rect.top - view.top, bottom: rect.bottom - view.top }
    }).filter(row => row.top >= -1 && row.bottom <= view.height + 1).sort((a, b) => a.top - b.top)
    return { at: performance.now(), top: list.scrollTop, height: list.scrollHeight, client: list.clientHeight, anchor: anchors[0] ?? null }
  }
  // The latest window leaves the trigger's recalibration to the pan.
  const incoming = [...list.querySelectorAll<HTMLElement>('[data-msg-chrome]')].filter(row => !row.hasAttribute('data-msg-own'))
  const ready = trigger === 'own-latest' ? incoming.length === 0
    : trigger === 'own-run' ? incoming.length > 0
    : !incoming.some(row => row.dataset.msgChrome === 'cont')
  if (!ready) throw new Error(`The latest window does not leave the ${trigger} recalibration to the pan`)
  let data: Observation | undefined
  let active = false, frame = 0, lastTop = list.scrollTop
  const setOptions = lib.setOptions
  lib.setOptions = function (options: Options) {
    if (active && data && options.count === lib.options.count && options.getItemKey !== lib.options.getItemKey) {
      data.refreshes.push({ at: performance.now(), direction: lib.scrollDirection, top: list.scrollTop, metrics: readMetrics(), before: sample() })
    }
    return setOptions.call(lib, options)
  }
  const onScroll = (event: Event) => {
    if (!active || !data) return
    data.scrolls.push({ at: performance.now(), from: lastTop, top: list.scrollTop, trusted: event.isTrusted })
    lastTop = list.scrollTop
  }
  const onInput = (event: MouseEvent) => { if (active && data) data.inputs.push({ at: performance.now(), trusted: event.isTrusted }) }
  // Capture before the virtualizer's ordinary scroll listener performs its synchronous render.
  list.addEventListener('scroll', onScroll, true)
  document.addEventListener('mousemove', onInput, true)
  const tick = () => { if (active && data) { data.samples.push(sample()); frame = requestAnimationFrame(tick) } }
  ;(window as unknown as CaptureWindow).estimatePanCapture = {
    read: () => ({ refreshes: data?.refreshes ?? [], top: list.scrollTop }),
    begin: () => {
      data = { start: sample(), initial: readMetrics(), samples: [], refreshes: [], inputs: [], scrolls: [] }
      lastTop = list.scrollTop; active = true; tick(); return data
    },
    stop: () => {
      active = false; cancelAnimationFrame(frame); lib.setOptions = setOptions
      list.removeEventListener('scroll', onScroll, true); document.removeEventListener('mousemove', onInput, true)
      return data!
    },
  }
}

// The refreshes carrying the trigger's metric change, and whether the pan has seen all of them.
function recalibrations(trigger: Trigger, initial: Metrics, refreshes: Refresh[]) {
  const width = (refresh: Refresh) => refresh.metrics.contentWidthPx
  if (trigger === 'chrome') {
    const changes = refreshes.filter(refresh => width(refresh) === initial.contentWidthPx && refresh.metrics.continuation !== initial.continuation)
    return { changes, complete: changes.length > 0 }
  }
  if (trigger === 'own-latest') {
    const changes = refreshes.filter(refresh => width(refresh) > initial.contentWidthPx)
    return { changes, complete: changes.length > 0 }
  }
  const narrowed = refreshes.filter(refresh => width(refresh) < initial.contentWidthPx)
  const restored = refreshes.filter(refresh => narrowed.length > 0 && refresh.at > narrowed[0].at && width(refresh) === initial.contentWidthPx)
  return { changes: [...narrowed, ...restored], complete: narrowed.length > 0 && restored.length > 0 }
}

const LABELS: Record<Trigger, string> = {
  'own-latest': 'the full width replacing a width sampled from own messages alone',
  'own-run': 'the width sample narrowing and widening across a run of own messages',
  chrome: 'the first continuation chrome correction',
}

const frames = (page: Page, count: number) => page.evaluate(count => new Promise<void>(resolve => {
  let seen = 0
  const tick = () => ++seen >= count ? resolve() : requestAnimationFrame(tick)
  requestAnimationFrame(tick)
}), count)

for (const kind of ['chat', 'room'] as const) {
  for (const trigger of ['own-latest', 'own-run', 'chrome'] as const) {
    test(`${kind}: native upward pan keeps visible progress through ${LABELS[trigger]}`, async ({ page }) => {
      await open(page, kind, trigger)
      await page.evaluate(installCapture, trigger)
      const box = (await page.locator('[data-message-list]').boundingBox())!
      const x = box.x + box.width / 2, y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down({ button: 'middle' })
      const { start, initial } = await page.evaluate(() => (window as unknown as CaptureWindow).estimatePanCapture.begin())
      // Hold the button and pull upward: Chromium's own autoscroll moves the list. The newly
      // mounted row is measured by the virtualizer's own observer; nothing is resized or scrolled
      // by script.
      await page.mouse.move(x, y - 60, { steps: 5 })
      await expect.poll(async () => {
        const progress = await page.evaluate(() => (window as unknown as CaptureWindow).estimatePanCapture.read())
        return recalibrations(trigger, initial, progress.refreshes).complete || progress.top <= 0
      }, { timeout: 60_000, intervals: [50] }).toBe(true)
      await frames(page, 60)
      const result = await page.evaluate(() => (window as unknown as CaptureWindow).estimatePanCapture.stop())
      await page.mouse.up({ button: 'middle' })
      await test.info().attach('native-pan-estimates', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })

      const { changes, complete } = recalibrations(trigger, initial, result.refreshes)
      expect(complete, `the ${trigger} recalibration must refresh estimates during the pan`).toBe(true)
      for (const refresh of changes) {
        // The library's own direction flag reads null between its offset poll's idle frames, so
        // the native scroll events on both sides of the refresh carry the backward motion. One
        // event can also fold in a measurement correction, so a few events are searched for a
        // native autoscroll step.
        const step = (scroll: Scroll) => scroll.trusted && scroll.top < scroll.from && scroll.from - scroll.top <= 20
        const previous = result.scrolls.filter(scroll => scroll.at < refresh.at).slice(-4)
        const following = result.scrolls.filter(scroll => scroll.at > refresh.at).slice(0, 4)
        // Offsets are not comparable across a refresh that moved them, so progress is read in messages.
        expect(refresh.before.anchor!.order, 'the native pan has moved before the refresh').toBeLessThan(start.anchor!.order)
        expect(previous.some(step), 'a native upward step precedes the refresh').toBe(true)
        expect(following.some(step), 'the native pan continues upward after it').toBe(true)
        const next = result.samples.find(sample => sample.at > refresh.at)
        expect(next, 'a frame follows the refresh').toBeDefined()
        expectProgress(refresh.before, next!, `${trigger} refresh`)
        expect(next!.at - refresh.before.at, 'a stalled frame around the refresh leaves its continuity unproven').toBeLessThanOrEqual(FRAME_GAP_MS)
        expectContinuity(refresh.before, next!, `${trigger} refresh`)
      }
      expect(result.inputs.length).toBeGreaterThan(0)
      expect(result.inputs.every(input => input.trusted)).toBe(true)
      expect(result.samples.at(-1)!.anchor!.order, 'the pan ends on an older message').toBeLessThan(start.anchor!.order)
      for (let i = 1; i < result.samples.length; i++) {
        expectProgress(result.samples[i - 1], result.samples[i], 'continuous native pan')
        expectContinuity(result.samples[i - 1], result.samples[i], 'continuous native pan')
      }
    })
  }
}
