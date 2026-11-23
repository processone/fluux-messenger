import { test, expect, type Locator, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { chatStore, roomStore } from '@fluux/sdk/stores'
import type { useSettingsStore } from '../apps/fluux/src/stores/settingsStore'
import type { useThemeStore } from '../apps/fluux/src/stores/themeStore'
import { bootDemo } from './harness/demoBoot'

// Approved design intent: give names the first line without widening the sidebar.
// Real showcase rows own the name-fit measurement; component tests own preview
// semantics, badge counts and typing priority. Browser geometry catches the old
// name/time collision that DOM-only component tests cannot see.
type DemoWindow = Window & {
  __demoClient: DemoClient
  __chatStore: typeof chatStore
  __roomStore: typeof roomStore
  __settingsStore: typeof useSettingsStore
  __themeStore: typeof useThemeStore
  __i18n: { changeLanguage: (language: string) => Promise<unknown> }
}
const rows = (page: Page, view: 'messages' | 'rooms') =>
  page.locator(view === 'messages' ? '[data-conv-id]' : '[data-room-jid]')

async function geometry(row: Locator, nameMustFit: boolean) {
  const metrics = await row.evaluate(element => {
    const name = element.querySelector('p')!
    const text = name.parentElement!.classList.contains('min-w-0')
      ? name.parentElement! : name.parentElement!.parentElement!
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
      timeBottom: t?.bottom, rowHeight: element.getBoundingClientRect().height,
    }
  })
  if (nameMustFit) expect(metrics.clipped, `${metrics.name} must fit`).toBe(false)
  if (metrics.timeStart !== undefined) {
    expect(metrics.timeTop).toBeGreaterThanOrEqual(metrics.nameBottom)
    expect(metrics.previewEnd).toBeLessThanOrEqual(metrics.timeStart)
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
      const w = window as DemoWindow
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
  })

  test(`narrow localized rows preserve state lines in ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 780 })
    await bootDemo(page, '/demo.html?scene=showcase&virt=1&density=compact')
    await page.evaluate(async mode => {
      const w = window as DemoWindow
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
      await page.evaluate(({ view, id }) => {
        const w = window as DemoWindow
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
      const draftGeometry = await geometry(row, false)
      expect(draftGeometry.clipped).toBe(true)
      await capture(page, `${view}-${mode}-minimum-draft`)
      await page.setViewportSize({ width: 320, height: 780 })
      await geometry(row, false)
      await page.evaluate(({ view, id }) => {
        const w = window as DemoWindow
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
      await expect(page.getByRole('button', { name: /Archive|Archiver|notification/i }).first()).toBeVisible()
      await page.keyboard.press('Escape')
    }
  })
}
