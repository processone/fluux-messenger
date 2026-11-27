import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, test, type Page, type Locator } from '@playwright/test'
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

export async function arrive(page: Page, kind: ConversationKind, ids: string[], own = false, body?: string) {
  await page.evaluate(({ kind, ids, own, body }) => {
    const scope = window as unknown as Demo
    const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
    const firstTimestamp = Date.now() - ids.length
    for (const [index, id] of ids.entries()) {
      const message = {
        id, stanzaId: undefined, originId: undefined, occupantId: undefined,
        from: kind === 'chat' ? own ? 'you@fluux.chat' : jid : `${jid}/${own ? 'You' : 'Adrien'}`,
        body: body ?? (own ? 'Let’s keep this message in place while choosing an action.' : 'A new update from the conversation.'),
        timestamp: new Date(firstTimestamp + index), isOutgoing: own,
      }
      if (kind === 'chat') scope.__demoClient.emitSDK('chat:message', { message: { ...message, type: 'chat', conversationId: jid }, isLiveArrival: true })
      else scope.__demoClient.emitSDK('room:message', { roomJid: jid, message: { ...message, type: 'groupchat', roomJid: jid, nick: own ? 'You' : 'Adrien' }, isLiveArrival: true, incrementUnread: true })
    }
  }, { kind, ids, own, body })
}

export async function setupInteraction(page: Page, kind: ConversationKind, restingPointer = false, virtualized = true, targetBody?: string) {
  if (process.env.FLUUX_INTERACTION_TRACE) page.on('console', message => {
    if (/\[Scroll\]|\[Interaction\]/.test(message.text())) console.log(message.text())
  })
  await bootDemo(page, `/demo.html?tutorial=false&virt=${virtualized ? 1 : 0}`)
  if (process.env.FLUUX_INTERACTION_TRACE) await page.evaluate(() => (window as any).__fluuxScrollDebug?.(true))
  await page.mouse.move(restingPointer ? 500 : 0, restingPointer ? 300 : 0)
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
  await arrive(page, kind, [TARGET], true, targetBody)
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
  const samples = await page.evaluate(() => (window as unknown as Window & { __holdSamples: { row: { x: number; y: number; width: number; height: number } | null; controls: { x: number; y: number; width: number; height: number }[] }[] }).__holdSamples)
  await keepJson('all-interaction-frame-samples', samples)
  expect(samples.length).toBeGreaterThan(2)
  const first = samples[0]
  expect(first.controls.length, 'geometry must include actual toolbar controls and panels').toBeGreaterThan(0)
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

export async function mountedMessageIndexes(page: Page) {
  return page.locator('[data-message-list] [data-virtualizer-spacer] > [data-index]')
    .evaluateAll(elements => elements.map(element => element.getAttribute('data-index')))
}

/** Read the SDK's canonical identity through its actual typed pointer contract. */
export async function readInteractionReadState(page: Page, kind: ConversationKind) {
  return page.evaluate(({ kind, jid }) => {
    const scope = window as unknown as Demo
    const current = kind === 'chat'
      ? { meta: scope.__chatStore.getState().conversationMeta.get(jid), messages: scope.__chatStore.getState().messages.get(jid) }
      : { meta: scope.__roomStore.getState().roomMeta.get(jid), messages: scope.__roomStore.getState().messages.get(jid) }
    if (!current.meta || !current.messages?.length) throw new Error('Missing interaction conversation state')
    return { unread: current.meta.unreadCount, readId: current.meta.readPointer?.identity.messageId ?? null, lastId: current.messages.at(-1)!.id }
  }, { kind, jid: jidFor(kind) })
}

/** Native interaction readings shared by the review regression journeys. */
export async function readInteractionView(page: Page, targetId = TARGET) {
  return page.evaluate(targetId => {
    const list = document.querySelector<HTMLElement>('[data-message-list]')!
    const toolbar = list.querySelector(`.message-row[data-message-id="${CSS.escape(targetId)}"] [data-message-toolbar]`)
    const active = document.activeElement
    return { held: list.getAttribute('data-message-interaction'), top: list.scrollTop,
      distance: list.scrollHeight - list.scrollTop - list.clientHeight,
      panels: list.querySelectorAll('[data-message-panel]').length,
      toolbarOpacity: toolbar ? getComputedStyle(toolbar).opacity : null,
      focus: active?.getAttribute('aria-label'), focusVisible: active?.matches(':focus-visible') ?? false,
      selectedText: document.getSelection()?.toString() ?? '' }
  }, targetId)
}

export const scrollToBottomContainer = (page: Page) => page.locator('[data-fab-container="scroll-to-bottom"]')

/** Observe actual native scrolling while the pointer remains pressed; never advance it by assignment. */
export async function interactionScrollFrames(page: Page, frames = 30) {
  return page.evaluate(frames => new Promise<{ top: number; held: string | null; selected: number }[]>(resolve => {
    const samples: { top: number; held: string | null; selected: number }[] = []
    const frame = () => {
      const list = document.querySelector<HTMLElement>('[data-message-list]')!
      samples.push({ top: list.scrollTop, held: list.getAttribute('data-message-interaction'), selected: document.getSelection()?.toString().length ?? 0 })
      if (samples.length === frames) resolve(samples)
      else requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }), frames)
}

/** Legacy find selects without revealing in Chromium; exercise the native reveal used by find UI too. */
export async function findAndRevealInteractionText(page: Page, query: string) {
  return page.evaluate(query => {
    const list = document.querySelector<HTMLElement>('[data-message-list]')!
    const before = list.scrollTop
    const found = (window as unknown as { find: (query: string) => boolean }).find(query)
    const afterFind = list.scrollTop
    if (found) {
      const selection = document.getSelection()
      if (!selection?.rangeCount) throw new Error('Native find returned no selected match')
      const range = selection.getRangeAt(0)
      const match = range.getBoundingClientRect(), viewport = list.getBoundingClientRect()
      if (match.top < viewport.top || match.bottom > viewport.bottom) {
        range.startContainer.parentElement?.scrollIntoView({ block: 'center' })
      }
    }
    return { found, before, afterFind, afterReveal: list.scrollTop }
  }, query)
}


export async function setInteractionTyping(page: Page, kind: ConversationKind, state: 'one' | 'two' | 'off', isolateBand = false) {
  await page.evaluate(({ kind, jid, state, isolateBand }) => {
    const client = (window as unknown as Demo).__demoClient
    const name = state === 'two' ? 'Emmanuelle Catherine Wilson – International infrastructure coordination' : 'Emma Wilson'
    let width = document.getElementById('interaction-typing-width')
    if (isolateBand) {
      if (!width) {
        width = document.createElement('style')
        width.id = 'interaction-typing-width'
        document.head.append(width)
      }
      // Only the typing slot changes width; contact names and message-row layout remain fixed.
      width.textContent = `[data-typing-pill] { max-width: ${state === 'two' ? 120 : 400}px; }`
    } else width?.remove()
    if (kind === 'chat') {
      if (!isolateBand) client.emitSDK('contacts:contact-updated', { jid, updates: { name } })
      client.emitSDK('chat:typing', { conversationId: jid, jid, isTyping: state !== 'off' })
    } else {
      client.emitSDK('room:typing', { roomJid: jid, nick: 'Adrien', isTyping: isolateBand ? state !== 'off' : state === 'one' })
      client.emitSDK('room:typing', { roomJid: jid, nick: 'Emmanuelle Catherine Wilson – International infrastructure coordination', isTyping: !isolateBand && state === 'two' })
    }
  }, { kind, jid: jidFor(kind), state, isolateBand })
  await expect(page.locator('[data-typing-pill]')).toHaveCount(state === 'off' ? 0 : 1)
}

export const ACTION_LINK_BODY = 'Review the notes: https://example.invalid/review'

export async function restoreMessageActionFocus(page: Page, row: Locator) {
  // Tab changes areas by design; Escape supplies the existing keyboard entry to a message button.
  await row.locator('[data-msg-text]').hover()
  await waitForActions(page, (await row.getAttribute('data-message-id'))!)
  const more = row.getByRole('button', { name: 'More options', exact: true })
  await more.click()
  await expect(row.locator('[data-message-panel="more"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(more).toBeFocused()
  await expect(row.locator('[data-message-panel]')).toHaveCount(0)
  await waitForActions(page, (await row.getAttribute('data-message-id'))!)
}

export async function tabOutOfMessageActions(page: Page) {
  const composer = page.locator('textarea.message-input, .message-input[contenteditable="true"]').last()
  const dateControls = page.locator('[data-date-pill]')
  const maximumDateStops = await dateControls.count()
  const stops: string[] = []
  await page.keyboard.press('Tab')
  // Native Tab must traverse the calendar controls; directly focusing the composer would conceal a broken route.
  for (let index = 0; index < maximumDateStops; index++) {
    const focusedDate = page.locator('[data-date-pill]:focus')
    if (await focusedDate.count() === 0) break
    await expect(focusedDate).toBeVisible()
    stops.push((await focusedDate.getAttribute('aria-label')) ?? '')
    await page.keyboard.press('Tab')
  }
  await expect(composer).toBeFocused()
  await test.info().attach('message-actions-tab-route', {
    body: JSON.stringify({ dateStops: stops, destination: await composer.getAttribute('aria-label') }),
    contentType: 'application/json',
  })
}

type LayoutRect = { top: number; bottom: number; left: number; right: number; width: number; height: number }
export interface InteractionLayoutFrame {
  phase?: 'baseline' | 'after-rendering' | 'pending-resize-delivery' | 'raf'
  deliveredBandHeight?: number | null
  deliveredViewportHeight?: number | null
  atMs?: number
  resizeEpoch?: number
  row: LayoutRect
  control: LayoutRect
  tail: LayoutRect | null
  panel: LayoutRect | null
  viewport: LayoutRect
  bandHeight: number
  toolbarOpacity: number
  scrollTop: number
  held: string | null
  connected: boolean
}

export async function sampleInteractionLayout(page: Page, elements: {
  row: Locator; control: Locator; tail?: Locator; tailText?: string; panel?: Locator; afterRendering?: boolean
}, action: () => Promise<unknown>): Promise<InteractionLayoutFrame[]> {
  const handles = {
    row: await elements.row.elementHandle(), control: await elements.control.elementHandle(),
    tail: await elements.tail?.elementHandle() ?? null, panel: await elements.panel?.elementHandle() ?? null,
  }
  try {
    await page.evaluate(({ row, control, tail, tailText, panel, afterRendering }) => {
      if (!row || !control) throw new Error('Missing layout observation target')
      const list = row.closest('[data-message-list]')!
      const scope = window as Window & { __interactionLayoutFrames?: InteractionLayoutFrame[]; __interactionLayoutFrame?: number; __interactionLayoutTimer?: number; __interactionLayoutObserver?: ResizeObserver }
      scope.__interactionLayoutFrames = []
      const box = (element: Element): LayoutRect => {
        const { top, bottom, left, right, width, height } = element.getBoundingClientRect()
        return { top, bottom, left, right, width, height }
      }
      let resizeEpoch = 0
      let deliveredBandHeight: number | null = null
      let deliveredViewport: LayoutRect | null = null
      const read = (phase: 'baseline' | 'after-rendering' | 'raf') => {
        const currentTail = tail?.isConnected ? tail : tailText ? [...list.querySelectorAll('.message-row')]
          .find(candidate => candidate.querySelector('[data-msg-text]')?.textContent?.trim() === tailText) : null
        const rowBounds = box(row), controlBounds = box(control)
        const tailBounds = currentTail ? box(currentTail) : null, panelBounds = panel ? box(panel) : null
        const viewport = box(list)
        const bandHeight = list.parentElement!.querySelector('[data-typing-band]')!.getBoundingClientRect().height
        const pendingResize = afterRendering && phase === 'after-rendering' &&
          (bandHeight !== deliveredBandHeight || viewport.height !== deliveredViewport?.height || viewport.width !== deliveredViewport?.width)
        scope.__interactionLayoutFrames!.push({ row: rowBounds, control: controlBounds, tail: tailBounds,
          panel: panelBounds, viewport,
          bandHeight,
          toolbarOpacity: Number(getComputedStyle(row.querySelector('[data-message-toolbar]')!).opacity),
          ...(afterRendering ? { phase: pendingResize ? 'pending-resize-delivery' : phase, atMs: performance.now(), resizeEpoch,
            deliveredBandHeight, deliveredViewportHeight: deliveredViewport?.height ?? null } : {}),
          scrollTop: list.scrollTop, held: list.getAttribute('data-message-interaction'),
          connected: row.isConnected && control.isConnected && (!tail || !!currentTail?.isConnected) })
      }
      const afterFrame = () => {
        if (scope.__interactionLayoutTimer !== undefined) return
        // Another task can mutate layout before this runs; the delivered dimensions distinguish that from a rendered resize.
        scope.__interactionLayoutTimer = window.setTimeout(() => {
          scope.__interactionLayoutTimer = undefined
          read('after-rendering')
        }, 0)
      }
      const tick = () => {
        if (afterRendering) afterFrame()
        else read('raf')
        scope.__interactionLayoutFrame = requestAnimationFrame(tick)
      }
      if (afterRendering) {
        scope.__interactionLayoutObserver = new ResizeObserver(() => {
          resizeEpoch++
          deliveredViewport = box(list)
          deliveredBandHeight = list.parentElement!.querySelector('[data-typing-band]')!.getBoundingClientRect().height
          afterFrame()
        })
        scope.__interactionLayoutObserver.observe(list)
        scope.__interactionLayoutObserver.observe(list.parentElement!.querySelector('[data-typing-band]')!)
      }
      read('baseline')
      scope.__interactionLayoutFrame = requestAnimationFrame(tick)
    }, { ...handles, tailText: elements.tailText, afterRendering: elements.afterRendering })
    try { await action() }
    finally {
      await page.evaluate(() => {
        const scope = window as Window & { __interactionLayoutFrame?: number; __interactionLayoutTimer?: number; __interactionLayoutObserver?: ResizeObserver }
        if (scope.__interactionLayoutFrame !== undefined) cancelAnimationFrame(scope.__interactionLayoutFrame)
        if (scope.__interactionLayoutTimer !== undefined) clearTimeout(scope.__interactionLayoutTimer)
        scope.__interactionLayoutTimer = undefined
        scope.__interactionLayoutObserver?.disconnect()
        scope.__interactionLayoutObserver = undefined
      })
    }
    const frames = await page.evaluate(() => (window as Window & { __interactionLayoutFrames?: InteractionLayoutFrame[] }).__interactionLayoutFrames!)
    expect(frames.length, 'layout observations must span browser frames').toBeGreaterThan(2)
    return frames
  } finally {
    await Promise.all(Object.values(handles).map(handle => handle?.dispose()))
  }
}

export function expectTypingClearance(frames: InteractionLayoutFrame[], protectTail: boolean, heldId?: string) {
  for (const frame of frames) {
    if (heldId !== undefined) expect(frame.held, 'the original action must retain its hold through every frame').toBe(heldId)
    expect(frame.connected, 'the original observed row and controls must remain mounted').toBe(true)
    expect(frame.control.top, 'active control top').toBeGreaterThanOrEqual(frame.viewport.top - 1)
    expect(frame.control.bottom, 'active control bottom').toBeLessThanOrEqual(frame.viewport.bottom + 1)
    if (frame.panel && frame.panel.height <= frame.viewport.height) {
      expect(frame.panel.top, 'fitting panel top').toBeGreaterThanOrEqual(frame.viewport.top - 1)
      expect(frame.panel.bottom, 'fitting panel bottom').toBeLessThanOrEqual(frame.viewport.bottom + 1)
    }
    const activeTop = frame.panel && frame.panel.height <= frame.viewport.height ? frame.panel.top : frame.control.top
    if (protectTail && frame.tail && frame.tail.height <= frame.viewport.height && frame.tail.bottom - activeTop <= frame.viewport.height) {
      expect(frame.tail.bottom, 'the former tail must stay whole when both fit').toBeLessThanOrEqual(frame.viewport.bottom + 1)
    }
  }
}
