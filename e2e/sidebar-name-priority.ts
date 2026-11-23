import { test, expect, type Locator, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { chatStore, roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'

// Sidebar hierarchy: give names the first line without widening the sidebar.
// Real showcase rows own the name-fit measurement; component tests own preview
// semantics, badge counts and typing priority. Browser geometry catches the old
// name/time collision that DOM-only component tests cannot see.
type DemoWindow = Window & {
  __demoClient: DemoClient
  __chatStore: typeof chatStore
  __roomStore: typeof roomStore
  __settingsStore: { getState: () => { setThemeMode: (mode: 'light' | 'dark') => void; setTimeFormat: (format: '12h' | '24h') => void; setFontSize: (size: number) => void } }
  __themeStore: { getState: () => { setActiveTheme: (id: string) => void } }
  __i18n: { changeLanguage: (language: string) => Promise<unknown> }
}
const rows = (page: Page, view: 'messages' | 'rooms') =>
  page.locator(view === 'messages' ? '[data-conv-id]' : '[data-room-jid]')

async function geometry(row: Locator, nameMustFit: boolean) {
  await expect(row).toBeVisible()
  const metrics = await row.evaluate(element => {
    const name = element.querySelector('p')!
    const text = name.parentElement!.parentElement!
    const previewLine = text.lastElementChild!
    const candidate = previewLine.querySelector(':scope > span')
    const time = candidate && candidate.getClientRects().length > 0 ? candidate : null
    const wrapper = previewLine.firstElementChild!
    const content = wrapper.firstElementChild
    const label = content?.querySelector('span[dir="auto"]')
    const n = name.getBoundingClientRect()
    const t = time?.getBoundingClientRect()
    const p = content?.getBoundingClientRect()
    return {
      name: name.textContent, clipped: name.scrollWidth > name.clientWidth,
      nameBottom: n.bottom, contentText: content?.textContent,
      contentStart: p?.left, contentEnd: p?.right, contentWidth: p?.width,
      contentFontSize: content ? parseFloat(getComputedStyle(content).fontSize) : undefined,
      typingLabelWidth: label?.getBoundingClientRect().width,
      typingDots: Array.from(content?.querySelectorAll('.typing-dot') ?? []).map(dot => {
        const r = dot.getBoundingClientRect()
        return { start: r.left, end: r.right }
      }),
      timeVisible: !!time, timeLabel: candidate?.textContent,
      timeStart: t?.left, timeTop: t?.top, timeEnd: t?.right,
      textEnd: text.getBoundingClientRect().right,
      timeClipped: time ? time.scrollWidth > time.clientWidth : false,
      avatarEnd: element.querySelector(':scope > .relative')!.getBoundingClientRect().right,
      rowHeight: element.getBoundingClientRect().height,
    }
  })
  if (nameMustFit) expect(metrics.clipped, `${metrics.name} must fit`).toBe(false)
  const previewEdge = metrics.timeStart ?? metrics.textEnd
  if (metrics.contentText?.trim()) {
    expect(metrics.contentWidth).toBeGreaterThanOrEqual(metrics.contentFontSize!)
    expect(metrics.contentEnd).toBeLessThanOrEqual(previewEdge)
  }
  if (metrics.typingLabelWidth !== undefined) {
    expect(metrics.typingLabelWidth).toBeGreaterThanOrEqual(metrics.contentFontSize!)
  }
  for (const dot of metrics.typingDots) {
    expect(dot.start).toBeGreaterThanOrEqual(metrics.contentStart!)
    expect(dot.end).toBeLessThanOrEqual(metrics.contentEnd!)
    expect(dot.end).toBeLessThanOrEqual(previewEdge)
  }
  if (metrics.timeVisible) {
    expect(metrics.timeTop).toBeGreaterThanOrEqual(metrics.nameBottom)
    expect(metrics.timeEnd).toBeLessThanOrEqual(metrics.textEnd)
    expect(metrics.timeClipped).toBe(false)
    expect(metrics.timeStart).toBeGreaterThanOrEqual(metrics.avatarEnd)
  }
  return metrics
}

async function showTyping(page: Page, view: 'messages' | 'rooms', id: string) {
  await page.evaluate(({ view, id }) => {
    const w = window as unknown as DemoWindow
    if (view === 'rooms') {
      w.__roomStore.getState().setDraft(id, '')
      w.__roomStore.getState().updateRoom(id, { unreadCount: 0, mentionsCount: 0 })
      w.__roomStore.getState().setTyping(id, 'Emma', true)
    } else {
      w.__chatStore.getState().setDraft(id, '')
      w.__chatStore.getState().setTyping(id, id, true)
    }
  }, { view, id })
}

async function setTimeFormat(page: Page, view: 'messages' | 'rooms', format: '12h' | '24h') {
  await page.evaluate(format => (window as unknown as DemoWindow).__settingsStore.getState().setTimeFormat(format), format)
  // The first showcase row is same-day; wait for its actual label to change.
  await expect(rows(page, view).first().locator('.sidebar-row-time')).toHaveText(
    format === '12h' ? /\b(?:AM|PM)\b/ : /^\d{2}:\d{2}$/,
  )
}

async function capture(page: Page, name: string) {
  if (process.env.SIDEBAR_PRIORITY_EVIDENCE_DIR) {
    await page.screenshot({ path: `${process.env.SIDEBAR_PRIORITY_EVIDENCE_DIR}/${name}-${test.info().project.name}.png` })
  }
}

for (const mode of ['light', 'dark'] as const) {
  test(`showcase names fit at the default width in ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 780 })
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
    await bootDemo(page, '/demo.html?scene=showcase&virt=1')
    await page.evaluate(mode => {
      const w = window as unknown as DemoWindow
      w.__themeStore.getState().setActiveTheme('fluux')
      w.__settingsStore.getState().setThemeMode(mode)
    }, mode)
    await expect(page.locator('aside')).toHaveCSS('width', '288px')
    for (const view of ['messages', 'rooms'] as const) {
      await page.locator(`[data-nav="${view}"]`).click()
      await expect(rows(page, view)).toHaveCount(view === 'messages' ? 6 : 3)
      const measured = []
      for (const row of await rows(page, view).all()) {
        const reading = await geometry(row, true)
        expect(reading.timeVisible).toBe(true)
        measured.push(reading)
      }
      await test.info().attach(`${view}-${mode}-geometry`, { body: JSON.stringify(measured, null, 2), contentType: 'application/json' })
      await capture(page, `${view}-${mode}`)
    }
    // The narrow-only exception must not hide default-width times
    // when the existing text-size setting is increased.
    const baseFont = await page.locator('html').evaluate(element => parseFloat(getComputedStyle(element).fontSize))
    const largerTextReadings = []
    for (const size of [105, 120]) {
      await page.evaluate(size => (window as unknown as DemoWindow).__settingsStore.getState().setFontSize(size), size)
      await expect.poll(() => page.locator('html').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(baseFont * size / 100, 3)
      for (const view of ['messages', 'rooms'] as const) {
        await page.locator(`[data-nav="${view}"]`).click()
        await expect(page.locator('aside')).toHaveCSS('width', '288px')
        await expect(rows(page, view)).toHaveCount(view === 'messages' ? 6 : 3)
        for (const row of await rows(page, view).all()) {
          const reading = await geometry(row, false)
          expect(reading.timeVisible).toBe(true)
          largerTextReadings.push({ size, view, ...reading })
        }
      }
    }
    await test.info().attach(`${mode}-larger-text`, { body: JSON.stringify(largerTextReadings, null, 2), contentType: 'application/json' })
    await page.evaluate(() => (window as unknown as DemoWindow).__settingsStore.getState().setFontSize(100))
    await expect.poll(() => page.locator('html').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(baseFont, 3)
    // A name's script direction must not move it away from the avatar.
    await page.locator('[data-nav="messages"]').click()
    const row = rows(page, 'messages').first()
    const id = (await row.getAttribute('data-conv-id'))!
    for (const [direction, name] of [['rtl', 'Emma Ward'], ['ltr', 'إيما وارد']] as const) {
      await page.evaluate(({ direction, name, id }) => {
        document.documentElement.dir = direction
        const store = (window as unknown as DemoWindow).__chatStore
        const conversations = new Map(store.getState().conversations)
        conversations.set(id, { ...conversations.get(id)!, name })
        store.setState({ conversations })
      }, { direction, name, id })
      await expect(row.locator('p').first()).toHaveText(name)
      const offset = await row.locator('p').first().evaluate((element, direction) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const letters = range.getBoundingClientRect()
        const line = element.parentElement!.getBoundingClientRect()
        return direction === 'rtl' ? line.right - letters.right : letters.left - line.left
      }, direction)
      expect(Math.abs(offset)).toBeLessThan(2)
    }
  })

  // A bodiless signal still carries a time, and must not expand
  // compact rows. A no-message row supplies the existing single-line height.
  test(`timestamp-only rows and drafts retain their time and density in ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 780 })
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
    for (const density of ['comfortable', 'compact']) {
      await bootDemo(page, `/demo.html?scene=showcase&virt=1&density=${density}`)
      await page.evaluate(mode => {
        const w = window as unknown as DemoWindow
        w.__themeStore.getState().setActiveTheme('fluux')
        w.__settingsStore.getState().setThemeMode(mode)
      }, mode)
      const id = (await rows(page, 'messages').nth(1).getAttribute('data-conv-id'))!
      const row = page.locator(`[data-conv-id="${id}"]`)
      // Drafts intentionally survive reloads; isolate each density's fixture.
      await page.evaluate(id => (window as unknown as DemoWindow).__chatStore.getState().setDraft(id, ''), id)
      await expect(row.locator('p.italic')).toHaveCount(0)
      const original = await page.evaluate(id => (window as unknown as DemoWindow).__chatStore.getState().conversations.get(id), id)
      if (!original?.lastMessage) throw new Error('The showcase conversation must have its real preview message')
      const normalHeight = (await row.boundingBox())!.height
      const time = row.locator('span.text-xs.text-fluux-muted')
      const expectedTime = await time.innerText()
      await page.evaluate(({ id, original }) => {
        const store = (window as unknown as DemoWindow).__chatStore
        const conversations = new Map(store.getState().conversations)
        conversations.set(id, { ...original, lastMessage: undefined })
        store.setState({ conversations })
      }, { id, original })
      await expect(time).toHaveCount(0)
      const emptyHeight = (await row.boundingBox())!.height
      await page.evaluate(({ id, original }) => {
        const store = (window as unknown as DemoWindow).__chatStore
        const conversations = new Map(store.getState().conversations)
        conversations.set(id, { ...original, lastMessage: {
          ...original.lastMessage!, body: '', attachment: undefined, forwarded: undefined,
          poll: undefined, pollClosed: undefined, isRetracted: false, unsupportedEncryption: undefined,
        } })
        store.setState({ conversations })
      }, { id, original })
      await expect(row.locator('p')).toHaveCount(1)
      await expect(time).toHaveText(expectedTime)
      const timestampOnly = await geometry(row, false)
      expect(timestampOnly.rowHeight).toBe(emptyHeight)
      expect(timestampOnly.timeVisible).toBe(true)
      await capture(page, `timestamp-only-${mode}-${density}`)
      await page.evaluate(({ id, body }) => (window as unknown as DemoWindow).__chatStore.getState().setDraft(id, body), { id, body: original.lastMessage.body })
      await expect(row.locator('p.italic')).toContainText(original.lastMessage.body)
      await expect(time).toHaveText(expectedTime)
      const draft = await geometry(row, false)
      expect(draft.rowHeight).toBe(normalHeight)
      expect(draft.timeVisible).toBe(true)
      await test.info().attach(`${mode}-${density}-empty-and-draft`, { body: JSON.stringify({ emptyHeight, timestampOnly, draft }, null, 2), contentType: 'application/json' })
      await page.evaluate(id => (window as unknown as DemoWindow).__chatStore.getState().setDraft(id, ''), id)
      await expect(row.locator('p.italic')).toHaveCount(0)
    }
  })

  test(`narrow localized rows preserve state lines in ${mode}`, async ({ page }) => {
    for (const density of ['comfortable', 'compact']) {
      await page.setViewportSize({ width: 1200, height: 780 })
      await bootDemo(page, `/demo.html?scene=showcase&virt=1&density=${density}`)
      await page.evaluate(async mode => {
        const w = window as unknown as DemoWindow
        w.__themeStore.getState().setActiveTheme('fluux')
        w.__settingsStore.getState().setThemeMode(mode)
        await w.__i18n.changeLanguage('fr')
      }, mode)
      // Exercise the existing drag handle rather than changing its stored width.
      const handle = page.locator('[role="separator"][aria-orientation="vertical"]')
      const box = (await handle.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + 100)
      await page.mouse.down()
      await page.mouse.move(0, box.y + 100)
      await page.mouse.up()
      const minimum = await page.locator('aside').boundingBox()
      expect(minimum!.width).toBeLessThan(288)

      for (const view of ['messages', 'rooms'] as const) {
        await page.locator(`[data-nav="${view}"]`).click()
        await expect(rows(page, view)).toHaveCount(view === 'messages' ? 6 : 3)
        const row = rows(page, view).nth(1)
        const id = (await row.getAttribute(view === 'messages' ? 'data-conv-id' : 'data-room-jid'))!
        const order = await rows(page, view).evaluateAll(elements => elements.map(e => e.getAttribute('data-conv-id') ?? e.getAttribute('data-room-jid')))
        const minimumReadings = []
        for (const format of ['12h', '24h'] as const) {
          await setTimeFormat(page, view, format)
          for (const item of await rows(page, view).all()) {
            const reading = await geometry(item, false)
            expect(reading.timeVisible).toBe(false)
            minimumReadings.push({ format, ...reading })
          }
        }
        await test.info().attach(`${view}-${mode}-${density}-french-minimum`, { body: JSON.stringify(minimumReadings, null, 2), contentType: 'application/json' })
        const originalTime = (await row.locator('span.text-xs.text-fluux-muted').textContent())!
        await page.evaluate(({ view, id }) => {
          const w = window as unknown as DemoWindow
          if (view === 'messages') {
            const store = w.__chatStore
            const conversations = new Map(store.getState().conversations)
            conversations.set(id, { ...conversations.get(id)!, name: `${conversations.get(id)!.name} — coordination internationale` })
            store.setState({ conversations })
            store.getState().setDraft(id, 'Je vous envoie la présentation cet après-midi.')
          } else {
            w.__roomStore.getState().updateRoom(id, { name: 'Équipe de lancement — coordination internationale' })
            w.__roomStore.getState().setDraft(id, 'Je vous envoie la présentation cet après-midi.')
          }
        }, { view, id })
        await expect(row).toContainText('Je vous envoie')
        await expect(row.locator('span.text-xs.text-fluux-muted')).toHaveText(originalTime)
        const draftGeometry = await geometry(row, false)
        expect(draftGeometry.clipped).toBe(true)
        expect(draftGeometry.timeVisible).toBe(false)
        await test.info().attach(`${view}-${mode}-${density}-minimum-draft`, { body: JSON.stringify(draftGeometry, null, 2), contentType: 'application/json' })
        await capture(page, `${view}-${mode}-${density}-minimum-draft`)
        const minimumTyping = []
        for (const format of ['12h', '24h'] as const) {
          await setTimeFormat(page, view, format)
          await showTyping(page, view, id)
          await expect(row.locator('.typing-dot').first()).toBeVisible()
          const reading = await geometry(row, false)
          expect(reading.timeVisible).toBe(false)
          if (view === 'rooms') expect(reading.typingLabelWidth).toBeGreaterThan(0)
          minimumTyping.push({ format, ...reading })
        }
        await test.info().attach(`${view}-${mode}-${density}-minimum-typing`, { body: JSON.stringify(minimumTyping, null, 2), contentType: 'application/json' })
        await capture(page, `${view}-${mode}-${density}-minimum-typing`)
        await page.setViewportSize({ width: 320, height: 780 })
        await page.getByRole('button', {
          name: view === 'messages' ? 'Retour aux conversations' : 'Retour aux salons', exact: true,
        }).click()
        await expect(rows(page, view)).toHaveCount(view === 'messages' ? 6 : 3)
        const phoneReadings = []
        for (const format of ['12h', '24h'] as const) {
          await setTimeFormat(page, view, format)
          for (const item of await rows(page, view).all()) {
            const reading = await geometry(item, false)
            expect(reading.timeVisible).toBe(true)
            phoneReadings.push({ format, ...reading })
          }
        }
        await test.info().attach(`${view}-${mode}-${density}-french-phone`, { body: JSON.stringify(phoneReadings, null, 2), contentType: 'application/json' })
        await showTyping(page, view, id)
        await expect(row.locator('.typing-dot').first()).toBeVisible()
        const phoneTyping = await geometry(row, false)
        expect(phoneTyping.timeVisible).toBe(true)
        if (view === 'rooms') expect(phoneTyping.typingLabelWidth).toBeGreaterThan(0)
        await test.info().attach(`${view}-${mode}-${density}-phone-typing`, { body: JSON.stringify(phoneTyping, null, 2), contentType: 'application/json' })
        await capture(page, `${view}-${mode}-${density}-phone-typing`)
        await page.setViewportSize({ width: 1200, height: 780 })
        expect(await rows(page, view).evaluateAll(elements => elements.map(e => e.getAttribute('data-conv-id') ?? e.getAttribute('data-room-jid')))).toEqual(order)
        await row.click({ button: 'right' })
        await expect(page.getByRole('button', {
          name: view === 'messages' ? 'Archiver' : 'Quitter le salon', exact: true,
        })).toBeVisible()
        await page.keyboard.press('Escape')
      }
    }
  })
}
