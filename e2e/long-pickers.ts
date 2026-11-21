import { expect, test, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import { waitForActions } from './harness/messageInteraction'
import { MAX_SUGGESTIONS } from '../apps/fluux/src/constants/ui'
import { bootDemo } from './harness/demoBoot'

// Suggestion mounts must be bounded without losing a late search
// result; Contacts must retain the entire scrollable roster. Exercise the real
// components and SDK event bindings, not a substitute renderer or timing budget.
const ROSTER_SIZE = 2000
const lastContact = `Colleague ${ROSTER_SIZE - 1}`
const lastNick = `U0_${ROSTER_SIZE - 1}`

async function bootLongRoster(page: Page) {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  // No activate:1: that fixture deliberately reasserts the room route for three
  // seconds and would undo navigation made while testing the other surfaces.
  await bootDemo(page, `/demo.html?tutorial=false&stress=rooms:1,messages:5,occupants:${ROSTER_SIZE},msgStep:0`)
  await seedRoster(page)
}

async function seedRoster(page: Page, shortNames = false) {
  await page.evaluate(({ count, shortNames }) => {
    const client = (window as unknown as { __demoClient: DemoClient }).__demoClient
    client.stopAnimation()
    client.emitSDK('contacts:loaded', { contacts: Array.from({ length: count }, (_,i) => ({
      jid: shortNames && i === count - 1 ? 'li@example.test' : shortNames && i === count - 2 ? 'liana@example.test' : `colleague${String(i).padStart(4, '0')}@example.test`,
      name: shortNames ? (i === count - 1 ? 'Li' : i === count - 2 ? 'Liana' : `Alicia ${String(i).padStart(4, '0')}`) : `Colleague ${String(i).padStart(4, '0')}`,
      presence: i % 2 ? 'online' as const : 'offline' as const,
      subscription: 'both' as const,
    })) })
  }, { count: ROSTER_SIZE, shortNames })
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await bootLongRoster(page)
})

test('palette bounds each group and still opens a late contact', async ({ page }) => {
  await page.mouse.move(0, 0)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog')
  const input = palette.getByRole('textbox')
  await input.fill('@colleague')
  const contacts = palette.locator('.command-group-label').filter({ hasText: /^Contacts$/ }).locator('..').locator('.command-row')
  await expect(contacts).toHaveCount(MAX_SUGGESTIONS)
  const status = palette.getByRole('status').filter({ hasText: `Showing ${MAX_SUGGESTIONS} of ${ROSTER_SIZE}, type to narrow` })
  await expect(status).toHaveText(`Showing ${MAX_SUGGESTIONS} of ${ROSTER_SIZE}, type to narrow`)
  await expect(status).toHaveAttribute('aria-live', 'polite')
  await expect(status).toHaveAttribute('aria-atomic', 'true')
  await expect(input).toBeFocused()
  await input.fill(`@colleague${ROSTER_SIZE - 1}`)
  await expect(contacts).toHaveCount(1)
  await expect(palette.locator('[data-suggestion-limit]')).toHaveCount(0)
  await input.press('Enter')
  await expect(palette).toBeHidden()
  await expect(page.getByRole('heading', { name: lastContact, exact: true })).toBeVisible()
})

test('recipient suggestions stay bounded and selected contacts stay excluded', async ({ page }) => {
  await page.locator('[data-nav="rooms"]').click()
  await page.getByRole('button', { name: 'Create Quick Chat', exact: true }).click()
  const input = page.getByPlaceholder('Search contacts...')
  await input.focus()
  const suggestions = page.getByTestId('contact-suggestions').getByRole('button')
  await expect(suggestions).toHaveCount(MAX_SUGGESTIONS)
  const status = page.getByTestId('contact-suggestions').getByRole('status')
  await expect(status).toHaveText(`Showing ${MAX_SUGGESTIONS} of ${ROSTER_SIZE}, type to narrow`)
  await expect(status).toHaveAttribute('aria-live', 'polite')
  await expect(input).toBeFocused()
  await input.fill(`colleague${ROSTER_SIZE - 1}`)
  await expect(suggestions).toHaveCount(1)
  await input.press('ArrowDown')
  await input.press('Enter')
  await expect(page.getByText(lastContact, { exact: true })).toBeVisible()
  const more = page.getByPlaceholder('Add more contacts...')
  await more.fill(`colleague${ROSTER_SIZE - 1}`)
  await expect(page.getByTestId('contact-suggestions').getByText(lastContact, { exact: true })).toHaveCount(0)
})

test('mention suggestions bound keyboard navigation and retain late nicknames', async ({ page }) => {
  await page.locator('[data-nav="rooms"]').click()
  await page.getByText('Stress 0', { exact: true }).click()
  const editor = page.getByRole('combobox', { name: /Stress 0/ })
  await editor.click()
  await page.keyboard.type('@')
  const options = page.getByRole('listbox').getByRole('option')
  await expect(options).toHaveCount(MAX_SUGGESTIONS)
  const status = page.getByRole('status').filter({ hasText: `Showing ${MAX_SUGGESTIONS} of ${ROSTER_SIZE + 1}, type to narrow` })
  await expect(status).toHaveText(`Showing ${MAX_SUGGESTIONS} of ${ROSTER_SIZE + 1}, type to narrow`)
  await expect(status).toHaveAttribute('aria-live', 'polite')
  await expect(page.getByRole('listbox').getByRole('status')).toHaveCount(0)
  await expect(page.getByRole('listbox').locator('[data-suggestion-limit]')).toHaveCount(0)
  await expect(editor).toBeFocused()
  await editor.press('ArrowUp')
  await expect(options.last()).toHaveAttribute('aria-selected', 'true')
  // The combobox's announced descendant must name an option that actually exists.
  await expect(editor).toHaveAttribute('aria-activedescendant', await options.last().getAttribute('id') as string)
  await editor.press('ControlOrMeta+a')
  await editor.press('Backspace')
  await page.keyboard.type(`@${lastNick}`)
  await expect(options).toHaveCount(1)
  await editor.press('Enter')
  await expect(editor.locator('[data-mention]')).toHaveText(`@${lastNick}`)
})

test('Contacts windows rows but keeps scroll, search and keyboard navigation', async ({ page }) => {
  await page.locator('[data-nav="contacts"]').click()
  const rows = page.locator('[data-contact-jid]')
  await expect(rows.first()).toBeVisible()
  await expect.poll(() => rows.count()).toBeLessThan(MAX_SUGGESTIONS)
  const scroller = rows.first().locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]')
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight })
  // The last offline contact sorts after the last online contact.
  const lastOffline = `colleague${String(ROSTER_SIZE - 2).padStart(4, '0')}@example.test`
  await expect(page.locator(`[data-contact-jid="${lastOffline}"]`)).toBeVisible()
  await expect.poll(() => rows.count()).toBeLessThan(MAX_SUGGESTIONS)
  const search = page.getByPlaceholder('Search contacts...')
  await search.fill(lastContact)
  await expect(rows).toHaveCount(1)
  // Return to the sidebar's keyboard focus zone before navigating its rows.
  await search.press('Shift+Tab')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: lastContact, exact: true })).toBeVisible()
  await search.fill('')
  // Move beyond the initial window with real keys, not a DOM scroll on an
  // already-mounted row; the selected row must be revealed by the virtualizer.
  await search.press('Shift+Tab')
  for (let i = 0; i < MAX_SUGGESTIONS + 5; i++) await page.keyboard.press('ArrowDown')
  const selected = page.locator('[data-contact-jid].keyboard-focus-row')
  await expect(selected).toBeVisible()
  await expect.poll(() => rows.count()).toBeLessThan(MAX_SUGGESTIONS)
})


test('review: a Forward room and non-roster chat retain space beside a large roster', async ({ page }) => {
  await page.locator('[data-nav="rooms"]').click()
  await page.getByRole('complementary').getByText('Stress 0', { exact: true }).click()
  await expect(page.getByRole('combobox', { name: /Stress 0/ })).toBeVisible()
  const row = page.getByRole('main').locator('[data-message-id][data-message-body]').first()
  const id = await row.getAttribute('data-message-id')
  await row.hover()
  await waitForActions(page, id!)
  await row.getByRole('button', { name: 'Forward message', exact: true }).click()
  const input = page.getByPlaceholder('Choose a chat or room')
  await input.focus()
  const suggestions = page.getByTestId('contact-suggestions')
  await expect(suggestions.getByRole('button', { name: /Ava Martinez/ })).toHaveCount(1)
  const room = suggestions.getByRole('button', { name: /Team Chat/ })
  await expect(room).toHaveCount(1)
  await room.scrollIntoViewIfNeeded()
  await room.click()
  await expect(page.getByRole('dialog').getByText('Team Chat', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('button', { name: /^Send/ })).toBeEnabled()
})

test('review: exact short names outrank broader matches in palette and recipients', async ({ page }) => {
  await seedRoster(page, true)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog')
  const field = palette.getByRole('textbox')
  await field.fill('@li')
  const contacts = palette.locator('.command-group-label').filter({ hasText: /^Contacts$/ }).locator('..').locator('.command-row')
  await expect(contacts.first()).toContainText('li@example.test')
  await expect(contacts.nth(1)).toContainText('liana@example.test')
  // Messages retain their section ahead of Contacts; navigate the actual rows
  // rather than assuming a contact must be the first item across all sections.
  const index = await palette.locator('.command-row').evaluateAll(rows => rows.findIndex(row => row.textContent?.includes('li@example.test')))
  expect(index).toBeGreaterThanOrEqual(0)
  for (let move = 0; move < index; move++) await field.press('ArrowDown')
  await field.press('Enter')
  await expect(page.getByRole('heading', { name: 'Li', exact: true })).toBeVisible()
  await page.locator('[data-nav="rooms"]').click()
  await page.getByRole('button', { name: 'Create Quick Chat', exact: true }).click()
  const input = page.getByPlaceholder('Search contacts...')
  await input.fill('li')
  const suggestions = page.getByTestId('contact-suggestions')
  await expect(suggestions.getByRole('button').first()).toContainText('li@example.test')
  await expect(suggestions.getByRole('button').nth(1)).toContainText('liana@example.test')
  await input.press('Enter')
  await expect(page.getByText('Li', { exact: true })).toBeVisible()
})

test('review: an exact history-only mention outranks current occupant prefixes', async ({ page }) => {
  await page.evaluate(count => {
    const client = (window as unknown as { __demoClient: DemoClient }).__demoClient
    const roomJid = 'stress-0@conference.fluux.chat'
    client.emitSDK('room:occupants-batch', { roomJid, occupants: Array.from({ length: count }, (_, i) => ({
      nick: `Liam${i}`, jid: `${roomJid}/Liam${i}`, affiliation: 'member' as const, role: 'participant' as const,
    })) })
    client.emitSDK('room:message', { roomJid, message: {
      type: 'groupchat', id: 'history-short-nick', roomJid, from: `${roomJid}/Li`, nick: 'Li',
      occupantId: undefined, stanzaId: undefined, originId: undefined,
      body: 'I will be away from the room today.', timestamp: new Date(), isOutgoing: false,
    }, isLiveArrival: false, incrementUnread: false })
  }, MAX_SUGGESTIONS + 5)
  await page.locator('[data-nav="rooms"]').click()
  await page.getByRole('complementary').getByText('Stress 0', { exact: true }).click()
  const editor = page.getByRole('combobox', { name: /Stress 0/ })
  await editor.click()
  await page.keyboard.type('@Li')
  await expect(page.getByRole('listbox').getByRole('option').first().getByText('@Li', { exact: true })).toBeVisible()
  await editor.press('Enter')
  await expect(editor.locator('[data-mention]')).toHaveText('@Li')
})

test('review: rename text survives a presence reorder that unmounts its contact row', async ({ page }) => {
  const jid = 'colleague0001@example.test'
  const row = page.locator(`[data-contact-jid="${jid}"]`)
  const input = await openRename(page, jid)
  await input.fill('Project coordinator')
  await page.evaluate(jid => {
    (window as unknown as { __demoClient: DemoClient }).__demoClient.emitSDK('contacts:presence-error', { jid, error: 'Remote server unavailable' })
  }, jid)
  await expect(row).toHaveCount(0)
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('Project coordinator')
})

test('review: the actual Contacts scrollbar retains each light theme color', async ({ page }) => {
  await page.locator('[data-nav="contacts"]').click()
  const row = page.locator('[data-contact-jid]').first()
  await expect(row).toBeVisible()
  const scroller = row.locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]')
  for (const id of ['fluux', 'nord']) {
    await page.evaluate(id => {
      const scope = window as unknown as { __themeStore: { getState(): { setActiveTheme(id: string): void } }; __settingsStore: { getState(): { setThemeMode(mode: 'light' | 'dark'): void } } }
      scope.__settingsStore.getState().setThemeMode('light')
      scope.__themeStore.getState().setActiveTheme(id)
      document.documentElement.dataset.scrollbars = 'always'
    }, id)
    await expect(page.locator('html')).toHaveAttribute('data-theme', id)
    await expect(page.locator('html')).toHaveClass(/light/)
    await expect.poll(() => scroller.evaluate(element => {
      const outer = document.querySelector('.sidebar-scroll')!
      return getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor === getComputedStyle(outer, '::-webkit-scrollbar-thumb').backgroundColor
    })).toBe(true)
  }
})


// Observe the real SDK serialization boundary; the demo's transport still owns
// delivery. No replacement rename implementation can hide a roster write here.
async function watchRosterWrites(page: Page) {
  await page.evaluate(() => {
    const scope = window as unknown as { __demoClient: DemoClient; __rosterWrites: string[] }
    scope.__rosterWrites = []
    const client = scope.__demoClient as unknown as { beginStanzaSend(stanza: { name: string; toString(): string }): Promise<void> }
    const original = client.beginStanzaSend.bind(client)
    client.beginStanzaSend = async stanza => {
      const xml = stanza.toString()
      if (stanza.name === 'iq' && xml.includes('type="set"') && xml.includes('jabber:iq:roster')) scope.__rosterWrites.push(xml)
      return original(stanza)
    }
  })
}

async function openRename(page: Page, jid: string) {
  await page.locator('[data-nav="contacts"]').click()
  await page.locator(`[data-contact-jid="${jid}"]`).click({ button: 'right' })
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  return page.locator('#contact-name')
}

test('review: removing a contact closes rename without a roster write or a later reopened dialog', async ({ page }) => {
  const jid = 'colleague0001@example.test'
  await watchRosterWrites(page)
  const input = await openRename(page, jid)
  await input.fill('Project coordinator')
  await page.evaluate(jid => {
    (window as unknown as { __demoClient: DemoClient }).__demoClient.emitSDK('contacts:contact-removed', { jid })
  }, jid)
  await expect(input).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __rosterWrites: string[] }).__rosterWrites)).toEqual([])
  // A later roster addition must not revive the removed contact's editing session.
  await page.evaluate(jid => {
    (window as unknown as { __demoClient: DemoClient }).__demoClient.emitSDK('contacts:contact', { contact: {
      jid, name: 'New roster name', presence: 'online', subscription: 'both',
    } })
  }, jid)
  await page.getByPlaceholder('Search contacts...').fill('New roster name')
  await expect(page.getByRole('complementary').getByText('New roster name', { exact: true })).toBeVisible()
  await expect(input).toHaveCount(0)
})

test('review: rename compares a draft with the live roster name, not the opening snapshot', async ({ page }) => {
  const jid = 'colleague0001@example.test'
  const originalName = 'Colleague 0001'
  await watchRosterWrites(page)
  const input = await openRename(page, jid)
  await expect(input).toHaveValue(originalName)
  await page.evaluate(jid => {
    (window as unknown as { __demoClient: DemoClient }).__demoClient.emitSDK('contacts:contact-updated', { jid, updates: { name: 'Remote name' } })
  }, jid)
  await expect(page.locator(`[data-contact-jid="${jid}"]`)).toHaveCount(0)
  // Keep the person's draft, but compare it to the new server name on Save.
  await expect(input).toHaveValue(originalName)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(input).toHaveCount(0)
  const writes = await page.evaluate(() => (window as unknown as { __rosterWrites: string[] }).__rosterWrites)
  expect(writes).toHaveLength(1)
  expect(writes[0]).toContain(`jid="${jid}"`)
  expect(writes[0]).toContain(`name="${originalName}"`)
})


test('palette category fallbacks stay bounded below every kind of name match', async ({ page }) => {
  const named = [
    { jid: 'ros@example.test', name: 'Ros' },
    { jid: 'ros-manager@example.test', name: 'Ros Manager' },
    { jid: 'ros-address@example.test', name: 'Zoe' },
    { jid: 'alex-r@example.test', name: 'Alex Ros' },
  ]
  await page.evaluate(contacts => {
    const client = (window as unknown as { __demoClient: DemoClient }).__demoClient
    for (const contact of contacts) client.emitSDK('contacts:contact', { contact: { ...contact, presence: 'online', subscription: 'both' } })
  }, named)
  await page.mouse.move(0, 0)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog')
  const input = palette.getByRole('textbox')
  await input.fill('@ros')
  const contacts = palette.locator('.command-group-label').filter({ hasText: /^Contacts$/ }).locator('..').locator('.command-row')
  await expect(contacts).toHaveCount(named.length)
  // Exact, prefix-name, prefix-local-part, and substring-name matches all beat
  // the roster keyword, even though the original roster sorts ahead of them.
  await expect(contacts.nth(0)).toContainText(named[0].jid)
  await expect(contacts.nth(1)).toContainText(named[1].jid)
  await expect(contacts.nth(2)).toContainText(named[2].jid)
  await expect(contacts.nth(3)).toContainText(named[3].jid)
  const fallback = palette.locator('.command-group-label').filter({ hasText: /^More matches$/ }).locator('..').locator('.command-row')
  await expect(fallback).toHaveCount(MAX_SUGGESTIONS)
  await expect(fallback.first()).toContainText('Colleague')
  const rows = await palette.locator('.command-row').allTextContents()
  expect(rows.slice(0, named.length).every(row => !row.includes('Colleague'))).toBe(true)
  expect(rows[named.length]).toContain('Colleague')
  await expect(palette.getByRole('status').filter({ hasText: `Showing ${MAX_SUGGESTIONS} of ${ROSTER_SIZE}, type to narrow` })).toBeAttached()
  await input.press('Enter')
  await expect(page.getByRole('heading', { name: 'Ros', exact: true })).toBeVisible()
})
