import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'
import { navigateToStressRoom } from './harness/scrollHarness'
import { ROOM_JID } from '../apps/fluux/src/demo/constants'

const locales = Object.fromEntries(['en', 'fr'].map(lang => [lang,
  JSON.parse(readFileSync(new URL(`../apps/fluux/src/i18n/locales/${lang}.json`, import.meta.url), 'utf8')),
]))

test.use({ reducedMotion: 'reduce', hasTouch: true })

// The accepted docked-header fix requires visible room identity, contained controls
// and an unobscured Members heading, not merely a non-overflowing outer header.
async function containedHeader(toggle: Locator, heading: Locator) {
  await expect.poll(() => toggle.evaluate(button => {
    const header = button.closest('header')!
    const title = header.querySelector('[data-testid="room-info-area"]')!
    const name = title.querySelector('span[aria-hidden="true"]')!
    const bounds = header.getBoundingClientRect()
    const inside = (el: Element) => {
      const rect = el.getBoundingClientRect()
      return rect.left >= bounds.left && rect.right <= bounds.right &&
        rect.top >= bounds.top && rect.bottom <= bounds.bottom
    }
    return title.getBoundingClientRect().width >= parseFloat(getComputedStyle(name).fontSize) &&
      inside(title) && inside(button) && title.getBoundingClientRect().right <= button.getBoundingClientRect().left &&
      Array.from(button.children).every(el =>
        getComputedStyle(el).display === 'none' || inside(el))
  }), 'room name has readable space and the complete toggle stays in its header').toBe(true)
  await expect.poll(() => heading.evaluate(el => {
    const rect = el.getBoundingClientRect()
    const panelHeader = el.parentElement!.getBoundingClientRect()
    const close = el.parentElement!.querySelector('button')!.getBoundingClientRect()
    return rect.left >= panelHeader.left && rect.right <= close.left &&
      close.right <= panelHeader.right && close.top >= panelHeader.top && close.bottom <= panelHeader.bottom &&
      rect.top >= panelHeader.top && rect.bottom <= panelHeader.bottom &&
      [0.1, 0.5, 0.9].every(fraction => el.contains(document.elementFromPoint(
        rect.left + rect.width * fraction, rect.top + rect.height / 2,
      )))
  }), 'Members heading is inside its panel and no control covers it').toBe(true)
}

async function resizeSidebar(page: Page, width: number) {
  const sidebar = page.locator('.chrome-sidebar')
  const handle = sidebar.locator('[role="separator"][aria-orientation="vertical"]')
  const box = await handle.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(width, box!.y + box!.height / 2)
  await page.mouse.up()
  await expect(sidebar).toHaveCSS('width', `${width}px`)
}

for (const lang of ['en', 'fr']) {
  for (const mode of ['light', 'dark']) {
    test(`${lang} ${mode}: docked Members leaves room identity and both close controls usable`, async ({ page }) => {
      const words = locales[lang]
      await page.setViewportSize({ width: 1024, height: 812 })
      await page.addInitScript(lang => localStorage.setItem('i18nextLng', lang), lang)
      await bootDemo(page, '/demo.html?tutorial=false')
      await page.evaluate(mode => {
        const w = window as any
        w.__demoClient.stopAnimation()
        w.__settingsStore.getState().setThemeMode(mode)
      }, mode)
      await navigateToStressRoom(page, false, ROOM_JID)
      const baseFont = await page.locator('html').evaluate(el => parseFloat(getComputedStyle(el).fontSize))
      const show = page.getByRole('button', { name: words.rooms.showMembers, exact: true })
      const hide = page.getByRole('button', { name: words.rooms.hideMembers, exact: true })
      const heading = page.getByRole('heading', { name: words.rooms.members, exact: true })
      await show.click()
      await expect(heading).toBeVisible()
      // The approved compact Members sizing trial owns these pixel expectations at 16px root text.
      // Roomy docks retain the header fix's 16rem baseline; compact docks return room to chat.
      for (const [width, text, sidebarWidth, panelWidth] of [
        [1024, 150, 400, 312],
        [1080, 150, 400, 312],
        [1120, 150, 400, 326],
        [1024, 100, 400, 256],
        [1280, 150, 400, 384],
        [1024, 150, 288, 342],
        [1280, 150, 288, 384],
      ]) {
        await page.setViewportSize({ width, height: 812 })
        await resizeSidebar(page, sidebarWidth)
        await page.evaluate(text => (window as any).__settingsStore.getState().setFontSize(text), text)
        const renderedFont = baseFont * text / 100
        await expect(page.locator('html')).toHaveCSS('font-size', `${renderedFont}px`)
        // WebKit can publish the root font before the rem-sized dock has caught up.
        await expect.poll(() => heading.evaluate(el =>
          el.parentElement!.parentElement!.getBoundingClientRect().width,
        )).toBe(panelWidth)
        if (width === 1024 && text === 150 && sidebarWidth === 400) {
          await expect.poll(async () => (await hide.locator('xpath=ancestor::header').boundingBox())!.width,
            'the compact dock returns 72px to the formerly 230px conversation').toBe(302)
        }
        for (const findOpen of [true, false]) {
          if (findOpen) await page.keyboard.press('Control+f')
          else await page.locator('[data-find-on-page-bar] input').press('Escape')
          await expect(page.locator('[data-find-on-page-bar]')).toHaveCount(findOpen ? 1 : 0)
          await containedHeader(hide, heading)
          if (process.env.FLUUX_MEMBERS_HEADER_PROOF) {
            await page.screenshot({ path: test.info().outputPath(`members-${width}-${text}-sidebar-${sidebarWidth}-find-${findOpen}.png`) })
          }
          await page.getByRole('button', { name: words.rooms.closePanel, exact: true }).click()
          await expect(heading).toHaveCount(0)
          await show.click()
          await expect(heading).toBeVisible()
          await hide.click()
          await expect(heading).toHaveCount(0)
          await show.focus()
          await page.keyboard.press('Enter')
          await expect(heading).toBeVisible()
          await page.getByRole('button', { name: words.rooms.closePanel, exact: true }).focus()
          await page.keyboard.press('Enter')
          await expect(heading).toHaveCount(0)
          await show.focus()
          await page.keyboard.press('Space')
          await expect(heading).toBeVisible()
          await hide.focus()
          await page.keyboard.press('Space')
          await expect(heading).toHaveCount(0)
          await show.click()
          await containedHeader(hide, heading)
        }
      }
      // The approved compact Members plan retains full identity access when long labels truncate.
      await page.setViewportSize({ width: 1024, height: 812 })
      await resizeSidebar(page, 400)
      await page.evaluate(() => (window as any).__settingsStore.getState().setFontSize(150))
      const nick = 'Emma Wilson — community coordination'
      const jid = 'emma.wilson@community.fluux.chat'
      await page.evaluate(({ nick, jid }) => {
        const store = (window as unknown as { __roomStore: typeof roomStore }).__roomStore.getState()
        const room = store.getRoom(store.activeRoomJid!)!
        const emma = room.occupants.get('Emma')!
        store.removeOccupant(room.jid, emma.nick)
        store.addOccupant(room.jid, {
          ...emma, nick, jid, occupantId: undefined,
          hats: [{ uri: 'urn:fluux:community-coordinator', title: 'Community coordinator' }],
        })
        store.addOccupant(room.jid, {
          ...emma, nick: 'Emma Wilson — mobile', jid, occupantId: undefined,
        })
      }, { nick, jid })
      await expect.poll(() => heading.evaluate(el =>
        el.parentElement!.parentElement!.getBoundingClientRect().width,
      )).toBe(312)
      await containedHeader(hide, heading)
      const row = page.locator('.touch-menu-row').filter({ has: page.getByText(nick, { exact: true }) })
      await expect(row.getByText('×2', { exact: true })).toBeVisible()
      await expect(row.locator(`[title="${words.rooms.affiliationAdmin}"]`)).toBeVisible()
      await expect(row.getByText('+1', { exact: true })).toBeVisible()
      const singleLabel = row.getByRole('button', { name: `${words.rooms.settings.fields.enableHats} (1)`, exact: true })
      await singleLabel.click()
      await expect(singleLabel).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByRole('tooltip').getByText('Community coordinator', { exact: true })).toBeVisible()
      await singleLabel.press('Escape')
      await expect(singleLabel).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByRole('tooltip')).toHaveCount(0)
      await expect.poll(() => row.getByText(jid, { exact: true }).evaluate(el =>
        el.clientWidth > 0 && el.scrollWidth > el.clientWidth,
      ), 'long address truncates inside the compact member row').toBe(true)
      await expect.poll(() => row.evaluate(el => {
        const bounds = el.getBoundingClientRect()
        return Array.from(el.querySelectorAll('svg, p, span')).every(child => {
          const rect = child.getBoundingClientRect()
          return rect.width === 0 || (rect.left >= bounds.left && rect.right <= bounds.right)
        }) && el.scrollWidth <= el.clientWidth
      }), 'long names, addresses and badges stay inside the compact member row').toBe(true)
      const name = row.getByText(nick, { exact: true })
      await expect.poll(() => name.evaluate(el =>
        el.clientWidth > 0 && el.scrollWidth > el.clientWidth,
      ), 'long member name truncates rather than widening the dock').toBe(true)
      await row.hover()
      await expect(page.getByRole('tooltip')).toContainText(nick)
      await name.click()
      const popover = page.locator('.fluux-popover').filter({ has: page.getByText(jid, { exact: true }) })
      await expect(popover).toBeVisible()
      await expect(popover.getByText(jid, { exact: true })).toBeVisible()
      if (process.env.FLUUX_MEMBERS_HEADER_PROOF) {
        await page.screenshot({ path: test.info().outputPath('members-compact-identity.png') })
      }
      await heading.click()
      await expect(popover).toHaveCount(0)

      // Identity warnings must survive clipped cores and adversarial edge-padding runs.
      for (const [padding, markedNick, edgeCount] of [
        ['ordinary', 'Emma Wilson — community\u200b ', 1],
        ['long', `${' '.repeat(64)}Emma Wilson — community\u200b${'\u00a0'.repeat(64)}`, 2],
      ] as const) {
        await page.evaluate(({ jid, nick }) => {
          const store = (window as unknown as { __roomStore: typeof roomStore }).__roomStore.getState()
          const room = store.getRoom(store.activeRoomJid!)!
          const emma = [...room.occupants.values()].find(occupant => occupant.jid === jid)!
          for (const occupant of room.occupants.values()) {
            if (occupant.jid === jid) store.removeOccupant(room.jid, occupant.nick)
          }
          store.addOccupant(room.jid, {
            ...emma, nick, affiliation: 'admin', role: 'moderator',
            hats: [
              { uri: 'urn:fluux:community', title: 'Community coordinator' },
              { uri: 'urn:fluux:release', title: 'Release coordination' },
              { uri: 'urn:fluux:support', title: 'Support' },
              { uri: 'urn:fluux:moderation', title: 'Moderation' },
            ],
          })
          store.addOccupant(room.jid, { ...emma, nick: `${nick}mobile`, hats: [] })
        }, { jid, nick: markedNick })
        const warningRow = page.locator('.touch-menu-row').filter({ has: page.getByTestId('nick-hidden-chars') })
        await expect(warningRow.getByTestId('nick-ws-marker')).toHaveCount(edgeCount)
        await expect(warningRow.getByText('×2', { exact: true })).toBeVisible()
        await expect(warningRow.locator(`[title="${words.rooms.affiliationAdmin}"]`)).toBeVisible()
        await expect(warningRow.getByText('+4', { exact: true })).toBeVisible()
        await expect.poll(() => warningRow.evaluate(el => {
          const row = el.getBoundingClientRect()
          const line = el.lastElementChild!.firstElementChild!
          const bounds = Array.from(line.children).map(child => child.getBoundingClientRect()).filter(rect => rect.width > 0)
          return bounds.every((rect, index) => rect.left >= row.left && rect.right <= row.right &&
            (index === 0 || rect.left >= bounds[index - 1].right))
        }), 'identity and connection, affiliation and extra-label badges remain separate and contained').toBe(true)
        const markers = warningRow.locator('[data-testid="nick-ws-marker"], [data-testid="nick-hidden-chars"]')
        for (const marker of await markers.all()) {
          await expect.poll(() => marker.evaluate(el => {
            const bounds = el.getBoundingClientRect()
            return bounds.width > 0 && bounds.height > 0 && [0.1, 0.5, 0.9].every(fraction =>
              el.contains(document.elementFromPoint(bounds.left + bounds.width * fraction, bounds.top + bounds.height / 2)),
            )
          }), 'identity marker is visibly painted, not clipped with the long nickname').toBe(true)
        }
        await expect.poll(() => warningRow.evaluate(el => {
          let list = el.parentElement!
          while (getComputedStyle(list).overflowY !== 'auto') list = list.parentElement!
          return el.scrollWidth <= el.clientWidth && list.scrollWidth <= list.clientWidth
        }), 'padding cannot widen the row or make the Members list scroll sideways').toBe(true)
        const disclosure = warningRow.getByRole('button', { name: `${words.rooms.settings.fields.enableHats} (4)`, exact: true })
        const extraLabels = page.getByRole('tooltip').filter({ has: page.getByText('Release coordination', { exact: true }) })
        // Focus explicitly: this owns control activation, not the separate Tab-navigation route.
        for (const activation of ['pointer', 'Enter', 'Space', 'touch']) {
          await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
          if (activation === 'pointer') await disclosure.click()
          else if (activation === 'touch') await disclosure.tap()
          else {
            await disclosure.focus()
            await disclosure.press(activation)
          }
          await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
          const controlled = await disclosure.getAttribute('aria-controls')
          if (!controlled) throw new Error('Open role labels require a controlled tooltip')
          await expect(extraLabels).toHaveAttribute('id', controlled)
          for (const label of ['Community coordinator', 'Release coordination', 'Support', 'Moderation']) {
            await expect(extraLabels.getByText(label, { exact: true })).toBeVisible()
          }
          await disclosure.press('Escape')
          await expect(disclosure).toBeFocused()
          await expect(extraLabels).toHaveCount(0)
        }
        if (process.env.FLUUX_MEMBERS_HEADER_PROOF) {
          await page.screenshot({ path: test.info().outputPath(`members-compact-markers-${padding}.png`) })
        }
      }
      // Switching members must replace the role disclosure without an outside click.
      await page.evaluate(() => {
        const store = (window as unknown as { __roomStore: typeof roomStore }).__roomStore.getState()
        const room = store.getRoom(store.activeRoomJid!)!
        const liam = room.occupants.get('Liam')!
        store.addOccupant(room.jid, { ...liam, hats: [
          { uri: 'urn:fluux:infrastructure', title: 'Infrastructure support' },
          { uri: 'urn:fluux:incident', title: 'Incident response' },
        ] })
      })
      const firstDisclosure = page.getByRole('button', { name: `${words.rooms.settings.fields.enableHats} (4)`, exact: true })
      const secondDisclosure = page.getByRole('button', { name: `${words.rooms.settings.fields.enableHats} (2)`, exact: true })
      const firstRoles = page.getByRole('tooltip').filter({ has: page.getByText('Release coordination', { exact: true }) })
      const secondRoles = page.getByRole('tooltip').filter({ has: page.getByText('Infrastructure support', { exact: true }) })
      await firstDisclosure.click()
      await expect(firstRoles).toBeVisible()
      await secondDisclosure.click()
      await expect(firstDisclosure).toHaveAttribute('aria-expanded', 'false')
      await expect(firstRoles).toHaveCount(0)
      await expect(secondRoles).toBeVisible()
      await secondDisclosure.press('Escape')
      await expect(secondRoles).toHaveCount(0)

      // Applying saved text size can hide the trigger without pointer input or viewport resize.
      await page.setViewportSize({ width: 1120, height: 812 })
      await firstDisclosure.click()
      await expect(firstRoles).toBeVisible()
      await page.evaluate(() => (window as any).__settingsStore.getState().setFontSize(100))
      await expect(page.locator('html')).toHaveCSS('font-size', `${baseFont}px`)
      await expect.poll(() => heading.evaluate(el =>
        el.parentElement!.parentElement!.getBoundingClientRect().width,
      )).toBe(16 * baseFont)
      await expect(firstDisclosure).toBeHidden()
      await expect(firstRoles).toHaveCount(0)
      expect(page.viewportSize()).toEqual({ width: 1120, height: 812 })
      await expect(page.locator('.chrome-sidebar')).toHaveCSS('width', '400px')
      await page.evaluate(() => (window as any).__settingsStore.getState().setFontSize(150))
      await expect(page.locator('html')).toHaveCSS('font-size', `${baseFont * 1.5}px`)
      await expect(firstDisclosure).toBeVisible()

      // Dragging owns the layout transition; its pointer-down also dismisses popups.
      await resizeSidebar(page, 288)
      await expect.poll(() => heading.evaluate(el =>
        el.parentElement!.parentElement!.getBoundingClientRect().width,
      )).toBe(16 * baseFont * 1.5)
      await expect(firstDisclosure).toBeHidden()
      await containedHeader(hide, heading)
      await resizeSidebar(page, 400)
      await page.setViewportSize({ width: 1024, height: 812 })
      await firstDisclosure.click()
      await expect(firstRoles).toBeVisible()
      await page.setViewportSize({ width: 1280, height: 812 })
      await expect(firstDisclosure).toBeHidden()
      await expect(firstRoles).toHaveCount(0)

      // Crossing lg must switch back to the unchanged fixed-width overlaid drawer.
      await page.setViewportSize({ width: 1024, height: 812 })
      await firstDisclosure.click()
      await expect(firstRoles).toBeVisible()
      await page.setViewportSize({ width: 1023, height: 812 })
      await expect(firstDisclosure).toBeHidden()
      await expect(firstRoles).toHaveCount(0)
      await expect.poll(() => heading.evaluate(el =>
        el.parentElement!.parentElement!.getBoundingClientRect().width,
      )).toBe(384)
      const drawer = heading.locator('..').locator('..').locator('..')
      await expect(drawer).toHaveCSS('position', 'fixed')
      const roomHeader = hide.locator('xpath=ancestor::header')
      await expect.poll(async () => (await roomHeader.boundingBox())!.width).toBeGreaterThan(384)
      if (process.env.FLUUX_MEMBERS_HEADER_PROOF) {
        await page.screenshot({ path: test.info().outputPath('members-drawer.png') })
      }
      await page.getByRole('button', { name: words.rooms.closePanel, exact: true }).click()
      await expect(heading).toHaveCount(0)
      await show.click()
      await expect(heading).toBeVisible()
      await page.setViewportSize({ width: 1280, height: 812 })
      await containedHeader(hide, heading)
      const roomyRow = page.locator('.touch-menu-row').filter({ has: page.getByTestId('nick-hidden-chars') })
      for (const label of ['Community coordinator', 'Release coordination', 'Support']) {
        await expect(roomyRow.getByText(label, { exact: true })).toBeVisible()
      }
      await expect(roomyRow.getByText('+1', { exact: true })).toBeVisible()
    })
  }
}
