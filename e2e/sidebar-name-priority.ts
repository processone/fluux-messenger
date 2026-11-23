import { test, expect, type Locator, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { chatStore, roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'

// Approved design intent: give names the first line without widening the sidebar.
// Real showcase rows own the name-fit measurement; component tests own preview
// semantics, badge counts and typing priority. Browser geometry catches the old
// name/time collision that DOM-only component tests cannot see.
type DemoWindow = Window & {
  __demoClient: DemoClient
  __chatStore: typeof chatStore
  __roomStore: typeof roomStore
  __settingsStore: { getState: () => { setThemeMode: (mode: 'light' | 'dark') => void } }
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
    const time = previewLine.querySelector(':scope > span')
    const preview = previewLine.firstElementChild!
    const n = name.getBoundingClientRect()
    const p = preview.getBoundingClientRect()
    const t = time?.getBoundingClientRect()
    return {
      name: name.textContent, clipped: name.scrollWidth > name.clientWidth,
      nameBottom: n.bottom, previewTop: p.top,
      previewEnd: p.right, timeStart: t?.left, timeTop: t?.top,
      timeBottom: t?.bottom, timeEnd: t?.right, textEnd: text.getBoundingClientRect().right,
      time: time?.textContent, timeClipped: time ? time.scrollWidth > time.clientWidth : false,
      avatarEnd: element.querySelector(':scope > .relative')!.getBoundingClientRect().right,
      rowHeight: element.getBoundingClientRect().height,
    }
  })
  if (nameMustFit) expect(metrics.clipped, `${metrics.name} must fit`).toBe(false)
  if (metrics.timeStart !== undefined) {
    expect(metrics.timeTop).toBeGreaterThanOrEqual(metrics.nameBottom)
    expect(metrics.previewEnd).toBeLessThanOrEqual(metrics.timeStart)
    expect(metrics.timeEnd).toBeLessThanOrEqual(metrics.textEnd)
    expect(metrics.timeClipped).toBe(false)
    expect(metrics.timeStart).toBeGreaterThanOrEqual(metrics.avatarEnd)
  }
  return metrics
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
      for (const row of await rows(page, view).all()) measured.push(await geometry(row, true))
      await test.info().attach(`${view}-${mode}-geometry`, { body: JSON.stringify(measured, null, 2), contentType: 'application/json' })
      await capture(page, `${view}-${mode}`)
    }
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

  // Review gap: a bodiless signal still carries a time, and must not expand
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
      await capture(page, `timestamp-only-${mode}-${density}`)
      await page.evaluate(({ id, body }) => (window as unknown as DemoWindow).__chatStore.getState().setDraft(id, body), { id, body: original.lastMessage.body })
      await expect(row.locator('p.italic')).toContainText(original.lastMessage.body)
      await expect(time).toHaveText(expectedTime)
      const draft = await geometry(row, false)
      expect(draft.rowHeight).toBe(normalHeight)
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
        const row = rows(page, view).nth(1)
        const id = (await row.getAttribute(view === 'messages' ? 'data-conv-id' : 'data-room-jid'))!
        const order = await rows(page, view).evaluateAll(elements => elements.map(e => e.getAttribute('data-conv-id') ?? e.getAttribute('data-room-jid')))
        const minimumReadings = []
        for (const item of await rows(page, view).all()) minimumReadings.push(await geometry(item, false))
        await test.info().attach(`${view}-${mode}-${density}-french-minimum`, { body: JSON.stringify(minimumReadings, null, 2), contentType: 'application/json' })
        const originalTime = await row.locator('span.text-xs.text-fluux-muted').innerText()
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
        await capture(page, `${view}-${mode}-minimum-draft`)
        await page.setViewportSize({ width: 320, height: 780 })
        await page.getByRole('button', {
          name: view === 'messages' ? 'Retour aux conversations' : 'Retour aux salons', exact: true,
        }).click()
        const phoneReadings = []
        for (const item of await rows(page, view).all()) phoneReadings.push(await geometry(item, false))
        await test.info().attach(`${view}-${mode}-${density}-french-phone`, { body: JSON.stringify(phoneReadings, null, 2), contentType: 'application/json' })
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
        await expect(row.locator('.typing-dot')).toHaveCount(3)
        await geometry(row, false)
        await capture(page, `${view}-${mode}-phone-typing`)
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
