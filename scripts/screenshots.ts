/**
 * Playwright script to generate marketing/documentation screenshots
 * from the Fluux demo mode.
 *
 * Usage:
 *   npm run screenshots
 *
 * Prerequisites:
 *   npm run build:sdk   (if not already built)
 *   npm run dev          (auto-started by Playwright if not running)
 */

import { test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'

const DEMO_URL = '/demo.html?tutorial=false'
const OUTPUT_DIR = 'screenshots'

// Ensure output directory exists
mkdirSync(OUTPUT_DIR, { recursive: true })

/** Wait for the demo to fully load and freeze animation state. */
async function waitForDemoReady(page: Page, colorScheme: 'dark' | 'light' = 'dark', url: string = DEMO_URL) {
  // Set color scheme BEFORE navigation so the theme resolves correctly on load
  await page.emulateMedia({ colorScheme })
  await page.goto(url)

  // Wait for sidebar navigation to render (proves React mounted)
  await page.waitForSelector('[data-nav="messages"]', { timeout: 15_000 })

  // Wait for conversation items to appear (proves stores are populated)
  await page.getByText('Emma Wilson').first().waitFor({ timeout: 10_000 })

  // Wait for images and assets to load
  await page.waitForLoadState('networkidle')

  // Stop the demo animation to prevent state changes during capture
  await page.evaluate(() => {
    const client = (window as any).__demoClient
    if (client?.stopAnimation) client.stopAnimation()
  })

  // Inject CSS tweaks for cleaner screenshots
  await page.addStyleTag({
    content: `
      /* Hide scrollbars */
      *::-webkit-scrollbar { display: none !important; }
      * { scrollbar-width: none !important; }
      /* Disable blinking caret */
      * { caret-color: transparent !important; }
      /* Disable all transitions for instant rendering */
      *, *::before, *::after {
        transition-duration: 0s !important;
        animation-duration: 0s !important;
      }
    `,
  })

  // Let everything settle after style injection
  await page.waitForTimeout(500)
}

/** Move mouse to a neutral position to avoid hover effects. */
async function clearHover(page: Page) {
  await page.mouse.move(640, 0)
}

/** Navigate to a sidebar view by clicking its icon rail button. */
async function navigateTo(page: Page, view: string) {
  await page.click(`[data-nav="${view}"]`)
  await page.waitForTimeout(800)
}

/** Select a conversation or room by clicking its name in the sidebar list. */
async function selectItem(page: Page, name: string) {
  await page.getByText(name, { exact: true }).first().click()
  await page.waitForTimeout(1000)
}

/** Take a screenshot and save to the output directory. */
async function capture(page: Page, filename: string) {
  await clearHover(page)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUTPUT_DIR}/${filename}.png`, type: 'png' })
}

// ── Dark Mode Screenshots ──────────────────────────────────────────

test('01 — 1:1 Chat (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'messages')
  await selectItem(page, 'Emma Wilson')
  await capture(page, '01-chat-dark')
})

test('02 — Group Chat with Members (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'rooms')
  await selectItem(page, 'Team Chat')

  // Open the occupant panel
  const membersBtn = page.locator('button[aria-label="Show members"]')
  if (await membersBtn.isVisible()) {
    await membersBtn.click()
    await page.waitForTimeout(500)
  }

  await capture(page, '02-group-chat-dark')
})

test('03 — Conversation List (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'messages')
  // Don't select any conversation — show the list prominently
  await capture(page, '03-conversation-list-dark')
})

test('3x — Conversation List Compact (dark)', async ({ page }) => {
  // Load demo with ?density=compact: demo.tsx calls setDensityMode('compact') at startup
  // (after its localStorage clear), so both the avatar size (store-driven) and the CSS
  // spacing (data-density attribute) render compact.
  await waitForDemoReady(page, 'dark', DEMO_URL + '&density=compact')
  await navigateTo(page, 'messages')
  await capture(page, '3x-conversation-list-compact-dark')
})

test('04 — Contact Directory (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'directory')
  // Select a contact to show the profile panel
  await selectItem(page, 'Emma Wilson')
  await capture(page, '04-contacts-dark')
})

test('05 — Poll in Room (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'rooms')
  await selectItem(page, 'Team Chat')

  // Scroll to the poll card
  const poll = page.locator('[class*="poll" i]').first()
  if (await poll.isVisible()) {
    await poll.scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
  }

  await capture(page, '05-poll-dark')
})

test('06 — Code Block (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'rooms')
  await selectItem(page, 'Team Chat')

  // Scroll to a code block (pre > code elements from syntax highlighting)
  const code = page.locator('pre code').first()
  if (await code.isVisible()) {
    await code.scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
  }

  await capture(page, '06-code-block-dark')
})

test('07 — Admin Server Overview (dark)', async ({ page }) => {
  await waitForDemoReady(page)

  // Vital-signs values shown on the overview cards. Defined once and re-applied
  // after the view mounts (the overview's mount fetch would otherwise overwrite
  // them with the raw DemoClient seed values).
  const SERVER_STATS = {
    registeredUsers: 1284,
    onlineUsers: 47,
    onlineRooms: 23,
    uptimeSeconds: 2001600, // 23d 4h
    version: 'ejabberd 25.07',
    vhostCount: 3,
    fetchedAt: Date.UTC(2026, 5, 20, 9, 24), // fixed → stable "updated at" time
  }

  // Ensure admin access + a stats category so the overview is reachable.
  await page.evaluate(() => {
    const adminStore = (window as any).__adminStore
    if (!adminStore) return
    const s = adminStore.getState()
    s.setIsAdmin(true)
    s.setCommands([
      { node: 'http://jabber.org/protocol/admin#get-registered-users-num', name: 'Get registered users number', category: 'stats' },
      { node: 'http://jabber.org/protocol/admin#get-online-users-num', name: 'Get online users number', category: 'stats' },
      { node: 'api-commands/stats', name: 'Stats', category: 'stats' },
    ])
  })

  await navigateTo(page, 'admin')
  // Entering the admin panel as an admin auto-lands on the Server Overview
  // (the 'stats' category) — there is no separate "Statistics" menu entry to
  // click anymore. Let the overview mount and its initial fetch settle before
  // we seed final values.
  await page.waitForTimeout(800)
  await page.evaluate((stats) => {
    const adminStore = (window as any).__adminStore
    if (adminStore) adminStore.getState().setServerStats(stats)
  }, SERVER_STATS)
  await page.waitForTimeout(400)
  await capture(page, '07-admin-dark')
})

test('08 — Settings Appearance (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'settings')
  // Navigate to the Appearance category
  await page.getByText('Appearance').first().click()
  await page.waitForTimeout(800)
  await capture(page, '08-settings-dark')
})

test('09 — Search (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'search')
  // Type a search query to show results
  const input = page.locator('input[type="text"]').first()
  await input.fill('design')
  await page.waitForTimeout(1500)
  // Click the first search result to show the preview panel
  const firstResult = page.locator('[data-search-result-id]').first()
  if (await firstResult.isVisible()) {
    await firstResult.click()
    await page.waitForTimeout(800)
  }
  await capture(page, '09-search-dark')
})

test('10 — Command Palette (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'messages')
  await selectItem(page, 'Emma Wilson')
  // Open the command palette with Cmd+K
  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(800)
  await capture(page, '10-command-palette-dark')
})

// ── Light Mode Screenshots ─────────────────────────────────────────

test('11 — 1:1 Chat (light)', async ({ page }) => {
  await waitForDemoReady(page, 'light')
  await navigateTo(page, 'messages')
  await selectItem(page, 'Emma Wilson')
  await capture(page, '11-chat-light')
})

test('12 — Group Chat with Members (light)', async ({ page }) => {
  await waitForDemoReady(page, 'light')
  await navigateTo(page, 'rooms')
  await selectItem(page, 'Team Chat')

  const membersBtn = page.locator('button[aria-label="Show members"]')
  if (await membersBtn.isVisible()) {
    await membersBtn.click()
    await page.waitForTimeout(500)
  }

  await capture(page, '12-group-chat-light')
})

// ── Theme Showcase Screenshots ────────────────────────────────────

/** Switch the active theme via the exposed themeStore. */
async function setTheme(page: Page, themeId: string) {
  await page.evaluate((id) => {
    const store = (window as any).__themeStore
    if (store) store.getState().setActiveTheme(id)
  }, themeId)
  await page.waitForTimeout(500)
}

const themeShowcase: { id: string; label: string }[] = [
  { id: 'nord', label: 'Nord' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'gruvbox', label: 'Gruvbox' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { id: 'rose-pine', label: 'Rosé Pine' },
]

for (const [i, theme] of themeShowcase.entries()) {
  const num = 13 + i
  test(`${num} — Chat ${theme.label} theme`, async ({ page }) => {
    await waitForDemoReady(page)
    await setTheme(page, theme.id)
    await navigateTo(page, 'messages')
    await selectItem(page, 'Emma Wilson')
    await capture(page, `${num}-chat-${theme.id}`)
  })
}

// ── i18n Screenshots ─────────────────────────────────────────────

/** Switch the UI language via the exposed i18n instance. */
async function setLanguage(page: Page, langCode: string) {
  await page.evaluate((code) => {
    const i18n = (window as any).__i18n
    if (i18n) void i18n.changeLanguage(code)
  }, langCode)
  await page.waitForTimeout(800)
}

test('19 — Chat (French)', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'fr')
  await navigateTo(page, 'messages')
  await selectItem(page, 'Emma Wilson')
  await capture(page, '19-chat-fr')
})

test('20 — Chat (Greek)', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'el')
  await navigateTo(page, 'messages')
  await selectItem(page, 'Emma Wilson')
  await capture(page, '20-chat-el')
})

test('21 — Chat (Arabic, RTL)', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'ar')
  await navigateTo(page, 'messages')
  await selectItem(page, 'Emma Wilson')
  await capture(page, '21-chat-ar')
})

test('22 — Chat (Hebrew, RTL)', async ({ page }) => {
  await waitForDemoReady(page)
  await setLanguage(page, 'he')
  await navigateTo(page, 'messages')
  await selectItem(page, 'Emma Wilson')
  await capture(page, '22-chat-he')
})

// ── Composite Screenshots ─────────────────────────────────────────

/** Capture the 1:1 chat view and return a PNG buffer. */
async function captureChatBuffer(page: Page, colorScheme: 'dark' | 'light'): Promise<Buffer> {
  await waitForDemoReady(page, colorScheme)
  await navigateTo(page, 'messages')
  await selectItem(page, 'Emma Wilson')
  await clearHover(page)
  await page.waitForTimeout(300)
  return Buffer.from(await page.screenshot({ type: 'png' }))
}

test('23 — Light/Dark Composite', async ({ page }) => {
  // Capture both themes
  const lightBuf = await captureChatBuffer(page, 'light')
  const darkBuf = await captureChatBuffer(page, 'dark')

  // Composite via an in-browser canvas (no extra npm deps)
  const lightB64 = lightBuf.toString('base64')
  const darkB64 = darkBuf.toString('base64')

  const compositeB64 = await page.evaluate(
    async ({ light, dark }) => {
      const loadImg = (b64: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = reject
          img.src = `data:image/png;base64,${b64}`
        })

      const [lightImg, darkImg] = await Promise.all([loadImg(light), loadImg(dark)])
      const W = lightImg.width
      const H = lightImg.height

      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')!

      // Draw light image as the base (full canvas)
      ctx.drawImage(lightImg, 0, 0)

      // Clip a diagonal triangle for the bottom-right half, then draw dark
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(W, 0)
      ctx.lineTo(W, H)
      ctx.lineTo(0, H)
      ctx.closePath()
      ctx.clip()
      ctx.drawImage(darkImg, 0, 0)
      ctx.restore()

      // Return the composited image as base64 PNG
      return canvas.toDataURL('image/png').replace('data:image/png;base64,', '')
    },
    { light: lightB64, dark: darkB64 }
  )

  writeFileSync(`${OUTPUT_DIR}/23-chat-light-dark.png`, Buffer.from(compositeB64, 'base64'))
})

// ── Blog Hero Illustration ───────────────────────────────────────

/** Capture a specific demo view and return a PNG buffer. */
async function captureViewBuffer(
  page: Page,
  setup: (page: Page) => Promise<void>
): Promise<Buffer> {
  await waitForDemoReady(page)
  await setup(page)
  await clearHover(page)
  await page.waitForTimeout(300)
  return Buffer.from(await page.screenshot({ type: 'png' }))
}

test('24 — Blog Hero v0.15.2', async ({ page }) => {
  // 0.15.2 story: Arabic + Hebrew translations with full RTL layout support.
  // Three panels: English baseline, Arabic (RTL), Hebrew (RTL).
  const chatBuf = await captureViewBuffer(page, async (p) => {
    await p.emulateMedia({ colorScheme: 'light' })
    await navigateTo(p, 'messages')
    await selectItem(p, 'Emma Wilson')
  })

  const arabicBuf = await captureViewBuffer(page, async (p) => {
    await setLanguage(p, 'ar')
    await p.emulateMedia({ colorScheme: 'light' })
    await navigateTo(p, 'messages')
    await selectItem(p, 'Emma Wilson')
  })

  const hebrewBuf = await captureViewBuffer(page, async (p) => {
    await setLanguage(p, 'he')
    await p.emulateMedia({ colorScheme: 'light' })
    await navigateTo(p, 'messages')
    await selectItem(p, 'Emma Wilson')
  })

  const buffers = {
    chat: chatBuf.toString('base64'),
    solarized: arabicBuf.toString('base64'),
    dracula: hebrewBuf.toString('base64'),
  }

  const compositeB64 = await page.evaluate(async (bufs) => {
    const loadImg = (b64: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = `data:image/png;base64,${b64}`
      })

    const loadUrl = (url: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = url
      })

    const [chatImg, solarizedImg, draculaImg, logoImg] = await Promise.all([
      loadImg(bufs.chat),
      loadImg(bufs.solarized),
      loadImg(bufs.dracula),
      loadUrl('/logo.png'),
    ])

    const W = 1920
    const H = 1080
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!

    // ── Background: soft gradient with brand color tint ──
    const grad = ctx.createLinearGradient(0, 0, W, H)
    grad.addColorStop(0, '#eef1ff')   // light blue-violet tint
    grad.addColorStop(0.5, '#f5f3ff') // lavender white
    grad.addColorStop(1, '#e8ecff')   // slightly deeper blue tint
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)

    // ── Header: logo + text ──
    const headerY = 30
    const logoSize = 64
    const centerX = W / 2

    const logoX = centerX - logoSize / 2
    ctx.drawImage(logoImg, logoX, headerY, logoSize, logoSize)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#1a1b1e'
    ctx.font = 'bold 52px Inter, system-ui, sans-serif'
    ctx.fillText('Fluux Messenger', centerX, headerY + logoSize + 14)

    ctx.fillStyle = '#5865f2'
    ctx.font = '600 38px Inter, system-ui, sans-serif'
    ctx.fillText('v0.15.2', centerX, headerY + logoSize + 76)

    ctx.fillStyle = '#6d6f78'
    ctx.font = '500 26px Inter, system-ui, sans-serif'
    ctx.fillText(
      'Arabic  \u00b7  Hebrew  \u00b7  RTL Support  \u00b7  Reliability  \u00b7  Security',
      centerX,
      headerY + logoSize + 126
    )

    // ── Helper: draw a rounded-rect screenshot card ──
    const radius = 16

    function drawCard(
      img: HTMLImageElement,
      cx: number,
      cy: number,
      w: number,
      h: number,
      angle: number,
    ) {
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate((angle * Math.PI) / 180)

      // Shadow
      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.25)'
      ctx.shadowBlur = 40
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 12
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, radius)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.restore()

      // Clip and draw screenshot
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, radius)
      ctx.clip()

      // Cover-fit the image into the card
      const imgAspect = img.width / img.height
      const cardAspect = w / h
      let sx: number, sy: number, sw: number, sh: number
      if (imgAspect > cardAspect) {
        sh = img.height
        sw = img.height * cardAspect
        sx = (img.width - sw) / 2
        sy = 0
      } else {
        sw = img.width
        sh = img.width / cardAspect
        sx = 0
        sy = 0
      }
      ctx.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h)
      ctx.restore()

      // Border for definition
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, radius)
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)'
      ctx.lineWidth = 1
      ctx.stroke()

      ctx.restore()
    }

    // ── Layout: 3 cards growing left → right, each overlapping the previous ──
    const cardsTop = 280
    const cardsCenterY = cardsTop + 300

    // Small (back-left): Default Light
    const smallW = 560
    const smallH = 440
    drawCard(chatImg, centerX - 420, cardsCenterY + 10, smallW, smallH, -4)

    // Medium (middle): Solarized
    const medW = 760
    const medH = 540
    drawCard(solarizedImg, centerX, cardsCenterY, medW, medH, 0)

    // Large (front-right): Dracula
    const largeW = 820
    const largeH = 580
    drawCard(draculaImg, centerX + 400, cardsCenterY - 10, largeW, largeH, 3)

    // ── Labels below the cards ──
    const labelY = cardsCenterY + largeH / 2 + 16
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = '600 24px Inter, system-ui, sans-serif'
    ctx.fillStyle = '#1a1b1e'
    ctx.fillText('English', centerX - 420, labelY)
    ctx.fillStyle = '#5865f2'
    ctx.font = 'bold 26px Inter, system-ui, sans-serif'
    ctx.fillText('Arabic (RTL)', centerX, labelY)
    ctx.fillStyle = '#5865f2'
    ctx.font = '600 24px Inter, system-ui, sans-serif'
    ctx.fillText('Hebrew (RTL)', centerX + 400, labelY)

    // ── Tagline at bottom ──
    ctx.fillStyle = '#4e5058'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = '600 30px Inter, system-ui, sans-serif'
    ctx.fillText('33 languages  \u00b7  Full right-to-left support', centerX, H - 110)

    return canvas.toDataURL('image/png').replace('data:image/png;base64,', '')
  }, buffers)

  writeFileSync(
    `${OUTPUT_DIR}/blog-hero-0.15.2.png`,
    Buffer.from(compositeB64, 'base64')
  )
})

// ── Feature Showcase: Encryption & Whispers ──────────────────────
// Appended after the existing 01–24 set so their numbering stays stable
// for any external references (blog posts, docs embeds).

test('25 — Encrypted Chat (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'messages')
  // Ava's thread carries OpenPGP security context on its recent messages —
  // verified / TOFU / untrusted locks plus a "could not decrypt" fallback.
  // It auto-scrolls to the latest, framing the encryption badges.
  await selectItem(page, 'Ava Martinez')
  await capture(page, '25-chat-encrypted-dark')
})

test('26 — Encryption Settings (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'settings')
  // Open the Encryption category. OpenPGP is enabled in demo, so the panel
  // shows the "ready" status plus the account fingerprint and key-management
  // actions (back up / export / rotate).
  await page.getByText('Encryption', { exact: true }).first().click()
  // Wait for the fingerprint to render — proves the panel reached "ready"
  // rather than capturing a transient "generating…" state.
  await page.locator('code').filter({ hasText: 'BAF0' }).first().waitFor({ timeout: 5_000 })
  await page.waitForTimeout(500)
  await capture(page, '26-settings-encryption-dark')
})

test('27 — Whisper in Room (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'rooms')
  await selectItem(page, 'Team Chat')
  // Scroll the private "whisper" thread (XEP-0045 §7.5) into view — it renders
  // as a bounded "Private with Emma" container near the end of the room.
  const whisper = page.getByText('Private with Emma').first()
  if (await whisper.isVisible()) {
    await whisper.scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
  }
  await capture(page, '27-whisper-dark')
})

// ── Blog Hero Illustration (v0.16.0) ─────────────────────────────
// 0.16.0 story: OpenPGP end-to-end encryption (primary) with mediated
// private "whispers" (secondary). Three light-mode panels — a private
// whisper thread, key backup/management settings, and an encrypted 1:1
// chat as the focal (front-right) card. Mirrors the v0.15.2 hero layout.
test('28 — Blog Hero v0.16.0', async ({ page }) => {
  const whisperBuf = await captureViewBuffer(page, async (p) => {
    await p.emulateMedia({ colorScheme: 'light' })
    await navigateTo(p, 'rooms')
    await selectItem(p, 'Team Chat')
    const whisper = p.getByText('Private with Emma').first()
    if (await whisper.isVisible()) {
      await whisper.scrollIntoViewIfNeeded()
      await p.waitForTimeout(500)
    }
  })

  const settingsBuf = await captureViewBuffer(page, async (p) => {
    await p.emulateMedia({ colorScheme: 'light' })
    await navigateTo(p, 'settings')
    await p.getByText('Encryption', { exact: true }).first().click()
    // Wait for the fingerprint so we capture the "ready" panel, not "generating…".
    await p.locator('code').filter({ hasText: 'BAF0' }).first().waitFor({ timeout: 5_000 })
    await p.waitForTimeout(300)
  })

  const encChatBuf = await captureViewBuffer(page, async (p) => {
    await p.emulateMedia({ colorScheme: 'light' })
    await navigateTo(p, 'messages')
    // Ava's thread carries OpenPGP security context — verified / TOFU / untrusted locks.
    await selectItem(p, 'Ava Martinez')
  })

  const buffers = {
    whisper: whisperBuf.toString('base64'),
    settings: settingsBuf.toString('base64'),
    encChat: encChatBuf.toString('base64'),
  }

  const compositeB64 = await page.evaluate(async (bufs) => {
    const loadImg = (b64: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = `data:image/png;base64,${b64}`
      })

    const loadUrl = (url: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = url
      })

    const [whisperImg, settingsImg, encChatImg, logoImg] = await Promise.all([
      loadImg(bufs.whisper),
      loadImg(bufs.settings),
      loadImg(bufs.encChat),
      loadUrl('/logo.png'),
    ])

    const W = 1920
    const H = 1080
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!

    // ── Background: soft gradient with brand color tint ──
    const grad = ctx.createLinearGradient(0, 0, W, H)
    grad.addColorStop(0, '#eef1ff')   // light blue-violet tint
    grad.addColorStop(0.5, '#f5f3ff') // lavender white
    grad.addColorStop(1, '#e8ecff')   // slightly deeper blue tint
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)

    // ── Header: logo + text ──
    const headerY = 30
    const logoSize = 64
    const centerX = W / 2

    const logoX = centerX - logoSize / 2
    ctx.drawImage(logoImg, logoX, headerY, logoSize, logoSize)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#1a1b1e'
    ctx.font = 'bold 52px Inter, system-ui, sans-serif'
    ctx.fillText('Fluux Messenger', centerX, headerY + logoSize + 14)

    ctx.fillStyle = '#5865f2'
    ctx.font = '600 38px Inter, system-ui, sans-serif'
    ctx.fillText('v0.16.0', centerX, headerY + logoSize + 76)

    ctx.fillStyle = '#6d6f78'
    ctx.font = '500 26px Inter, system-ui, sans-serif'
    ctx.fillText(
      'OpenPGP  ·  End-to-End Encryption  ·  Private Whispers  ·  Key Backup',
      centerX,
      headerY + logoSize + 126
    )

    // ── Helper: draw a rounded-rect screenshot card ──
    const radius = 16

    function drawCard(
      img: HTMLImageElement,
      cx: number,
      cy: number,
      w: number,
      h: number,
      angle: number,
    ) {
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate((angle * Math.PI) / 180)

      // Shadow
      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.25)'
      ctx.shadowBlur = 40
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 12
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, radius)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.restore()

      // Clip and draw screenshot
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, radius)
      ctx.clip()

      // Cover-fit the image into the card
      const imgAspect = img.width / img.height
      const cardAspect = w / h
      let sx: number, sy: number, sw: number, sh: number
      if (imgAspect > cardAspect) {
        sh = img.height
        sw = img.height * cardAspect
        sx = (img.width - sw) / 2
        sy = 0
      } else {
        sw = img.width
        sh = img.width / cardAspect
        sx = 0
        sy = 0
      }
      ctx.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h)
      ctx.restore()

      // Border for definition
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, radius)
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)'
      ctx.lineWidth = 1
      ctx.stroke()

      ctx.restore()
    }

    // ── Layout: 3 cards growing left → right, each overlapping the previous ──
    const cardsTop = 280
    const cardsCenterY = cardsTop + 300

    // Small (back-left): Private whisper thread
    drawCard(whisperImg, centerX - 420, cardsCenterY + 10, 560, 440, -4)

    // Medium (middle): Encrypted chat
    drawCard(encChatImg, centerX, cardsCenterY, 760, 540, 0)

    // Large (front-right): Key backup / encryption settings — the headline
    const largeH = 580
    drawCard(settingsImg, centerX + 400, cardsCenterY - 10, 820, largeH, 3)

    // ── Labels below the cards ──
    const labelY = cardsCenterY + largeH / 2 + 16
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = '600 24px Inter, system-ui, sans-serif'
    ctx.fillStyle = '#1a1b1e'
    ctx.fillText('Private Whispers', centerX - 420, labelY)
    ctx.fillStyle = '#5865f2'
    ctx.font = 'bold 26px Inter, system-ui, sans-serif'
    ctx.fillText('End-to-End Encrypted', centerX, labelY)
    ctx.fillStyle = '#1a1b1e'
    ctx.font = '600 24px Inter, system-ui, sans-serif'
    ctx.fillText('Key Backup & Restore', centerX + 400, labelY)

    // ── Tagline at bottom ──
    ctx.fillStyle = '#4e5058'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = '600 30px Inter, system-ui, sans-serif'
    ctx.fillText('OpenPGP end-to-end encryption  ·  Private group whispers', centerX, H - 110)

    return canvas.toDataURL('image/png').replace('data:image/png;base64,', '')
  }, buffers)

  writeFileSync(
    `${OUTPUT_DIR}/blog-hero-0.16.0.png`,
    Buffer.from(compositeB64, 'base64')
  )
})

// ── Blog Hero Illustration (v0.16.1) ─────────────────────────────
// 0.16.1 story: reliability & polish on top of 0.16.0. Reuses the same
// three light-mode panels as the 0.16.0 hero — a private whisper thread,
// key backup/management settings, and an encrypted 1:1 chat as the focal
// (front-right) card — re-skinned with the version, feature strip, and
// tagline reframed around the "now faster and more reliable" theme.
test('29 — Blog Hero v0.16.1', async ({ page }) => {
  const whisperBuf = await captureViewBuffer(page, async (p) => {
    await p.emulateMedia({ colorScheme: 'light' })
    await navigateTo(p, 'rooms')
    await selectItem(p, 'Team Chat')
    const whisper = p.getByText('Private with Emma').first()
    if (await whisper.isVisible()) {
      await whisper.scrollIntoViewIfNeeded()
      await p.waitForTimeout(500)
    }
  })

  const settingsBuf = await captureViewBuffer(page, async (p) => {
    await p.emulateMedia({ colorScheme: 'light' })
    await navigateTo(p, 'settings')
    await p.getByText('Encryption', { exact: true }).first().click()
    // Wait for the fingerprint so we capture the "ready" panel, not "generating…".
    await p.locator('code').filter({ hasText: 'BAF0' }).first().waitFor({ timeout: 5_000 })
    await p.waitForTimeout(300)
  })

  const encChatBuf = await captureViewBuffer(page, async (p) => {
    await p.emulateMedia({ colorScheme: 'light' })
    await navigateTo(p, 'messages')
    // Ava's thread carries OpenPGP security context — verified / TOFU / untrusted locks.
    await selectItem(p, 'Ava Martinez')
  })

  const buffers = {
    whisper: whisperBuf.toString('base64'),
    settings: settingsBuf.toString('base64'),
    encChat: encChatBuf.toString('base64'),
  }

  const compositeB64 = await page.evaluate(async (bufs) => {
    const loadImg = (b64: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = `data:image/png;base64,${b64}`
      })

    const loadUrl = (url: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = url
      })

    const [whisperImg, settingsImg, encChatImg, logoImg] = await Promise.all([
      loadImg(bufs.whisper),
      loadImg(bufs.settings),
      loadImg(bufs.encChat),
      loadUrl('/logo.png'),
    ])

    const W = 1920
    const H = 1080
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!

    // ── Background: soft gradient with brand color tint ──
    const grad = ctx.createLinearGradient(0, 0, W, H)
    grad.addColorStop(0, '#eef1ff')   // light blue-violet tint
    grad.addColorStop(0.5, '#f5f3ff') // lavender white
    grad.addColorStop(1, '#e8ecff')   // slightly deeper blue tint
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)

    // ── Header: logo + text ──
    const headerY = 30
    const logoSize = 64
    const centerX = W / 2

    const logoX = centerX - logoSize / 2
    ctx.drawImage(logoImg, logoX, headerY, logoSize, logoSize)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#1a1b1e'
    ctx.font = 'bold 52px Inter, system-ui, sans-serif'
    ctx.fillText('Fluux Messenger', centerX, headerY + logoSize + 14)

    ctx.fillStyle = '#5865f2'
    ctx.font = '600 38px Inter, system-ui, sans-serif'
    ctx.fillText('v0.16.1', centerX, headerY + logoSize + 76)

    ctx.fillStyle = '#6d6f78'
    ctx.font = '500 26px Inter, system-ui, sans-serif'
    ctx.fillText(
      'End-to-End Encryption  ·  Private Whispers  ·  Faster & More Reliable',
      centerX,
      headerY + logoSize + 126
    )

    // ── Helper: draw a rounded-rect screenshot card ──
    const radius = 16

    function drawCard(
      img: HTMLImageElement,
      cx: number,
      cy: number,
      w: number,
      h: number,
      angle: number,
    ) {
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate((angle * Math.PI) / 180)

      // Shadow
      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.25)'
      ctx.shadowBlur = 40
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 12
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, radius)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.restore()

      // Clip and draw screenshot
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, radius)
      ctx.clip()

      // Cover-fit the image into the card
      const imgAspect = img.width / img.height
      const cardAspect = w / h
      let sx: number, sy: number, sw: number, sh: number
      if (imgAspect > cardAspect) {
        sh = img.height
        sw = img.height * cardAspect
        sx = (img.width - sw) / 2
        sy = 0
      } else {
        sw = img.width
        sh = img.width / cardAspect
        sx = 0
        sy = 0
      }
      ctx.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h)
      ctx.restore()

      // Border for definition
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, radius)
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)'
      ctx.lineWidth = 1
      ctx.stroke()

      ctx.restore()
    }

    // ── Layout: 3 cards growing left → right, each overlapping the previous ──
    const cardsTop = 280
    const cardsCenterY = cardsTop + 300

    // Small (back-left): Private whisper thread
    drawCard(whisperImg, centerX - 420, cardsCenterY + 10, 560, 440, -4)

    // Medium (middle): Encrypted chat
    drawCard(encChatImg, centerX, cardsCenterY, 760, 540, 0)

    // Large (front-right): Key backup / encryption settings — the headline
    const largeH = 580
    drawCard(settingsImg, centerX + 400, cardsCenterY - 10, 820, largeH, 3)

    // ── Labels below the cards ──
    const labelY = cardsCenterY + largeH / 2 + 16
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = '600 24px Inter, system-ui, sans-serif'
    ctx.fillStyle = '#1a1b1e'
    ctx.fillText('Private Whispers', centerX - 420, labelY)
    ctx.fillStyle = '#5865f2'
    ctx.font = 'bold 26px Inter, system-ui, sans-serif'
    ctx.fillText('End-to-End Encrypted', centerX, labelY)
    ctx.fillStyle = '#1a1b1e'
    ctx.font = '600 24px Inter, system-ui, sans-serif'
    ctx.fillText('Key Backup & Restore', centerX + 400, labelY)

    // ── Tagline at bottom ──
    ctx.fillStyle = '#4e5058'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = '600 30px Inter, system-ui, sans-serif'
    ctx.fillText('End-to-end encryption & private whispers — now faster and more reliable', centerX, H - 110)

    return canvas.toDataURL('image/png').replace('data:image/png;base64,', '')
  }, buffers)

  writeFileSync(
    `${OUTPUT_DIR}/blog-hero-0.16.1.png`,
    Buffer.from(compositeB64, 'base64')
  )
})

// ── Message Identity: sender colors, own-edge, new-message divider ────────
// Captures the Aurora message-identity slice (Task 7).
// Design Review has 4 distinct senders (Olivia, Emma, Mia, own/outgoing),
// so each sender name renders in a distinct Aurora-tuned hue.
// Outgoing messages show the subtle accent left-edge (.message-own-edge).
// Note: the new-messages divider is only visible when the room has unread
// messages on entry. In demo mode (unreadCount=0) the divider is not shown;
// the scene focuses on per-sender colors and the own-message edge instead.

test('30 — Message Identity — sender colors + own-edge (dark)', async ({ page }) => {
  await waitForDemoReady(page)
  await navigateTo(page, 'rooms')
  await selectItem(page, 'Design Review')
  // Scroll to the top of the thread so multiple distinct senders are visible
  // with their colored names, and at least one own (outgoing) message is in frame.
  await page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"], .message-list, [class*="messageList"]')
    if (list) list.scrollTop = 0
  })
  await page.waitForTimeout(600)
  await capture(page, '30-message-identity-dark')
})

test('30b — Message Identity — sender colors + own-edge (light)', async ({ page }) => {
  await waitForDemoReady(page, 'light')
  await navigateTo(page, 'rooms')
  await selectItem(page, 'Design Review')
  await page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"], .message-list, [class*="messageList"]')
    if (list) list.scrollTop = 0
  })
  await page.waitForTimeout(600)
  await capture(page, '30-message-identity-light')
})
