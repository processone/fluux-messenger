/** Intent FLM-39 (captain): verify server-confirmed choices in demo.html, including
 * keyboard use, narrow/large-text/RTL layouts, visible saving and read-only retry.
 * These are controlled server fixtures, not evidence from a live XMPP account. */
import { test, expect, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'

type Policy = 'always' | 'roster' | 'never'
async function setup(page: Page, state = 'ready') {
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(async state => {
    const w = window as any
    w.__demoClient.stopAnimation()
    await w.__i18n.changeLanguage('en')
    const server = { default: 'roster', always: ['romeo@montague.lit'], never: ['tybalt@capulet.lit'] }
    const fixture = w.__archiveFixture = { server, reads: 0, writes: [] as unknown[], state, finish: null as null | (() => void) }
    w.__demoClient.supportsMAM = () => fixture.state !== 'unsupported'
    w.__demoClient.getArchivingPreferences = async () => {
      fixture.reads++
      if (fixture.state === 'loading') return new Promise(() => {})
      if (fixture.state === 'error') throw new Error('network')
      return structuredClone(fixture.server)
    }
    w.__demoClient.setArchivingPreferences = (next: typeof server) => {
      fixture.writes.push(structuredClone(next))
      if (fixture.state === 'denied') return Promise.reject(Object.assign(new Error('forbidden'), { condition: 'forbidden' }))
      return new Promise(resolve => {
        fixture.finish = () => { fixture.server = next; resolve(next) }
      })
    }
    const account = w.__connectionStore.getState().jid.split('/')[0]
    sessionStorage.setItem(`xmpp-session:${account}`, JSON.stringify({ jid: account }))
    w.__settingsStore.setState({ archiveOverrides: { [account]: { value: 'always', original: 'roster' } } })
    w.__connectionStore.getState().setStatus(state === 'offline' ? 'reconnecting' : 'online')
    location.hash = '/settings/privacy'
  }, state)
  await expect(page.locator('#server-archive-label')).toBeVisible()
}
const choice = (page: Page, policy: Policy) => page.getByRole('button', { name: {
  always: 'All exchanges', roster: 'Contacts only', never: 'No exchanges',
}[policy], exact: true })

test('keyboard save waits for confirmation, preserves fresh exceptions and blocks concurrent actions', async ({ page }) => {
  await setup(page)
  await expect(choice(page, 'roster')).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => {
    const f = (window as any).__archiveFixture
    f.server.always = ['juliet@capulet.lit']; f.server.never = ['paris@verona.lit']
  })
  await choice(page, 'never').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'Saving and waiting' })).toBeVisible()
  await expect(choice(page, 'never')).toBeDisabled()
  await expect(choice(page, 'roster')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate(() => (window as any).__archiveFixture.writes)).toEqual([
    { default: 'never', always: ['juliet@capulet.lit'], never: ['paris@verona.lit'] },
  ])
  await page.evaluate(() => (window as any).__archiveFixture.finish())
  await expect(choice(page, 'never')).toHaveAttribute('aria-pressed', 'true')
  await expect(choice(page, 'never')).toBeEnabled()
  await expect(page.getByText('Contact exceptions take priority: always 1, never 1.')).toBeVisible()
  await page.evaluate(() => {
    const w = window as any
    w.__connectionStore.getState().setStatus('reconnecting')
  })
  await expect(page.getByText('Connect to read or change this setting.')).toBeVisible()
  await expect(choice(page, 'never')).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => (window as any).__connectionStore.getState().setStatus('online'))
  await expect(choice(page, 'never')).toBeEnabled()
  expect(await page.evaluate(() => (window as any).__archiveFixture.writes.length)).toBe(1)
})

test('a refused write keeps the last confirmation and retry reads instead of resubmitting', async ({ page }) => {
  await setup(page, 'denied')
  await choice(page, 'never').click()
  await expect(page.getByRole('alert')).toHaveText('The server refused access to these preferences.')
  await expect(choice(page, 'roster')).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Read server setting again' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(choice(page, 'roster')).toBeEnabled()
  expect(await page.evaluate(() => (window as any).__archiveFixture.writes.length)).toBe(1)
})

for (const [state, text] of [
  ['loading', 'Reading server preferences…'], ['offline', 'Connect to read or change this setting.'],
  ['unsupported', 'Your server does not support archiving preferences.'],
  ['error', 'Could not read or save. Read again to check the server setting.'],
]) {
  test(`shows ${state} separately without a confirmed selection`, async ({ page }) => {
    await setup(page, state)
    await expect(page.getByText(text, { exact: true })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Server archiving' })).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__archiveFixture.writes.length)).toBe(0)
  })
}

for (const variant of ['mobile', 'large', 'rtl'] as const) {
  test(`${variant} keeps all choices readable and keyboard-accessible`, async ({ page }) => {
    await setup(page)
    if (variant !== 'large') await page.setViewportSize({ width: 390, height: 900 })
    await page.evaluate(async variant => {
      if (variant === 'large') document.documentElement.style.fontSize = '24px'
      if (variant === 'rtl') await (window as any).__i18n.changeLanguage('ar')
    }, variant)
    const group = page.getByRole('group').first()
    const buttons = group.getByRole('button')
    await expect(buttons).toHaveCount(3)
    for (const button of await buttons.all()) {
      await button.scrollIntoViewIfNeeded()
      await expect(button).toBeVisible()
      await button.focus()
      await expect(button).toBeFocused()
      expect(await button.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (variant === 'rtl') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await page.screenshot({ path: test.info().outputPath(`privacy-${variant}.png`) })
  })
}
