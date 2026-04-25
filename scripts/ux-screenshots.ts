/**
 * UX-audit screenshot capture — companion to docs/UX_REVIEW.md.
 *
 * Renders every top-level view, mobile widths, and the light theme into
 * docs/ux-review-screenshots/. Re-run on each release (or before drafting a
 * new audit) to regenerate the evidence the review document references.
 *
 *   npm run ux:audit
 *
 * Complements scripts/screenshots.ts (marketing/blog hero shots) — that one
 * produces curated, polished frames; this one captures audit-relevant states
 * (empty, narrow viewport, light/dark) without composition or theming.
 */

import { test, type Page } from '@playwright/test'
import { mkdirSync } from 'fs'

const DEMO_URL = '/demo.html?tutorial=false'
const OUTPUT_DIR = 'docs/ux-review-screenshots'

mkdirSync(OUTPUT_DIR, { recursive: true })

async function waitForDemoReady(page: Page, colorScheme: 'dark' | 'light' = 'dark') {
  await page.emulateMedia({ colorScheme })
  await page.goto(DEMO_URL)
  await page.waitForSelector('[data-nav="messages"]', { timeout: 15_000 })
  await page.getByText('Emma Wilson').first().waitFor({ timeout: 10_000 })
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => {
    const client = (window as any).__demoClient
    if (client?.stopAnimation) client.stopAnimation()
  })
  await page.addStyleTag({
    content: `
      *::-webkit-scrollbar { display: none !important; }
      * { scrollbar-width: none !important; }
      * { caret-color: transparent !important; }
      *, *::before, *::after {
        transition-duration: 0s !important;
        animation-duration: 0s !important;
      }
    `,
  })
  await page.waitForTimeout(500)
}

async function clearHover(page: Page) {
  await page.mouse.move(640, 0)
}

async function setLanguage(page: Page, langCode: string) {
  await page.evaluate((code) => {
    const i18n = (window as any).__i18n
    if (i18n) void i18n.changeLanguage(code)
  }, langCode)
  await page.waitForTimeout(800)
}

async function navigateTo(page: Page, view: string) {
  await page.click(`[data-nav="${view}"]`)
  await page.waitForTimeout(800)
}

async function selectItem(page: Page, name: string) {
  await page.getByText(name, { exact: true }).first().click()
  await page.waitForTimeout(800)
}

async function capture(page: Page, filename: string) {
  await clearHover(page)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUTPUT_DIR}/${filename}.png`, type: 'png' })
}

// ── Top-level views ────────────────────────────────────────────────

test('messages-1to1', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'messages')
  await selectItem(page, 'Emma Wilson')
  await capture(page, '02-messages-1to1')
})

test('rooms-with-members', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'rooms')
  await selectItem(page, 'Team Chat')
  const membersBtn = page.locator('button[aria-label="Show members"]')
  if (await membersBtn.isVisible()) {
    await membersBtn.click()
    await page.waitForTimeout(500)
  }
  await capture(page, '03-rooms-with-members')
})

test('directory-empty', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'directory')
  await capture(page, '04-directory-list')
})

test('directory-profile', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'directory')
  await selectItem(page, 'Emma Wilson')
  await capture(page, '05-directory-profile')
})

test('archives-empty', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'archive')
  await capture(page, '06-archives')
})

test('events-list', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'events')
  await capture(page, '07-events')
})

test('search-empty', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'search')
  await capture(page, '08-search-empty')
})

test('admin-dashboard', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'admin')
  await capture(page, '09-admin')
})

test('settings-default', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'settings')
  await capture(page, '10-settings')
})

// ── Modals & overlays ──────────────────────────────────────────────

test('command-palette', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'messages')
  await selectItem(page, 'Emma Wilson')
  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(800)
  await capture(page, '11-command-palette')
})

test('directory-empty-detail', async ({ page }) => {
  // Directory tab with no contact selected — shows the empty "Contact Information" pane.
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'directory')
  await capture(page, '12-directory-empty-detail')
})

test('rooms-default', async ({ page }) => {
  // Rooms tab with Team Chat selected, member panel closed — daily-driver state.
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'rooms')
  await selectItem(page, 'Team Chat')
  await capture(page, '13-rooms-default')
})

// ── Mobile width ───────────────────────────────────────────────────

test('mobile-messages-list', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'messages')
  await capture(page, '14-mobile-messages-list')
})

test('mobile-1to1-chat', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await waitForDemoReady(page)
  await setLanguage(page, 'en')
  await navigateTo(page, 'messages')
  await selectItem(page, 'Emma Wilson')
  await capture(page, '15-mobile-chat')
})

// ── Light theme ────────────────────────────────────────────────────

test('light-messages-1to1', async ({ page }) => {
  await waitForDemoReady(page, 'light')
  await setLanguage(page, 'en')
  await navigateTo(page, 'messages')
  await selectItem(page, 'Emma Wilson')
  await capture(page, '16-light-1to1')
})

test('light-settings', async ({ page }) => {
  await waitForDemoReady(page, 'light')
  await setLanguage(page, 'en')
  await navigateTo(page, 'settings')
  await capture(page, '17-light-settings')
})

// ── Login screen (force logout to see it) ──────────────────────────

test('login-screen', async ({ page }) => {
  // Force a fresh state by going to root without demo session
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)
  await capture(page, '18-login-screen')
})
