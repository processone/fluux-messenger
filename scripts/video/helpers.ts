/**
 * Low-level setup for the Fluux demo video recorder.
 *
 * The capturing logic lives in director.ts (a stepped recorder that takes one
 * native-resolution screenshot per output frame). This module only holds the
 * constants, page bootstrap, and the promo overlay injection (synthetic cursor,
 * caption, title card).
 */

import { type Page } from '@playwright/test'

// ── Constants ──────────────────────────────────────────────────────

export const BASE_URL = 'http://localhost:5173'
export const DEMO_URL = `${BASE_URL}/demo.html?tutorial=false`
/**
 * CSS viewport the app lays out in — deliberately denser than the output (same
 * width as the marketing screenshots) so the UI fills the frame instead of
 * leaving wide empty gutters. Combined with deviceScaleFactor in record.ts
 * (RENDER_SIZE × 1.5 = VIDEO_SIZE), the page rasterises straight to the output
 * resolution, so page.screenshot() captures native 1080p frames — no upscaling.
 */
export const RENDER_SIZE = { width: 1280, height: 720 }
/** Output video dimensions (native device-pixel capture, no scaling). */
export const VIDEO_SIZE = { width: 1920, height: 1080 }

/** Demo JIDs (stable in demo seed data — see apps/fluux/src/demo/). */
export const DOMAIN = 'fluux.chat'
export const SELF_JID = `you@${DOMAIN}`
export const ROOM_JID = `team@conference.${DOMAIN}`

/** Maps an icon-rail view to its router path (most are 1:1). */
export const VIEW_PATHS: Record<string, string> = {
  messages: '/messages',
  rooms: '/rooms',
  directory: '/contacts',
  archive: '/archive',
  events: '/events',
  search: '/search',
  admin: '/admin',
  settings: '/settings',
}

// ── Readiness ──────────────────────────────────────────────────────

/**
 * Open the demo page and paint a dark background immediately, so the brief
 * Vite/React load shows dark (matching the title card) instead of white.
 */
export async function openDemo(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { document.documentElement.style.background = '#0b0c18' } catch { /* no DOM yet */ }
  })
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    document.documentElement.style.background = '#0b0c18'
    document.body.style.background = '#0b0c18'
  })
  await page.addStyleTag({
    content: `
      *::-webkit-scrollbar { display: none !important; }
      * { scrollbar-width: none !important; }
      * { caret-color: transparent !important; }
    `,
  })
}

/**
 * Wait until the demo app is fully interactive, then stop the auto-started
 * 5-minute global timeline so we can drive our own deterministic beats.
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForSelector('[data-nav="messages"]', { timeout: 20_000 })
  await page.getByText('Emma Wilson').first().waitFor({ timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => {
    const client = (window as any).__demoClient
    if (client?.stopAnimation) client.stopAnimation()
  })
  await page.waitForTimeout(300)
}

// ── Promo overlays (cursor, caption, title card) ───────────────────

/**
 * Inject the synthetic cursor, caption (lower third) and full-screen title-card
 * overlays. All layers are `pointer-events: none` so real Playwright mouse
 * events still drive the app. The Director drives their opacity per frame, so
 * the (frozen) CSS transitions here don't matter — only the initial styles do.
 */
export async function installPolishLayers(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.getElementById('vid-cursor')) return
    const NS = 'http://www.w3.org/2000/svg'

    const style = document.createElement('style')
    style.textContent = `
      #vid-cursor, #vid-caption, #vid-title { position: fixed; pointer-events: none; }
      #vid-cursor {
        z-index: 2147483647; left: 0; top: 0; width: 28px; height: 28px;
        margin: -2px 0 0 -2px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.45));
      }
      #vid-caption {
        z-index: 2147483640; bottom: 8%; left: 50%;
        transform: translate(-50%, 0); opacity: 0;
        max-width: 78%; padding: 16px 26px; border-radius: 16px; text-align: center;
        background: rgba(15,17,21,.74); backdrop-filter: blur(10px);
        box-shadow: 0 10px 40px rgba(0,0,0,.35);
        font-family: Inter, system-ui, -apple-system, sans-serif; color: #fff;
      }
      #vid-caption .t { font-size: 32px; font-weight: 700; line-height: 1.15; }
      #vid-caption .s { font-size: 19px; font-weight: 400; opacity: .82; margin-top: 6px; }
      #vid-title {
        z-index: 2147483645; inset: 0; opacity: 0;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 18px; text-align: center;
        background: radial-gradient(120% 120% at 50% 30%, #2b2f63 0%, #14152b 55%, #0b0c18 100%);
        font-family: Inter, system-ui, -apple-system, sans-serif; color: #fff;
      }
      #vid-title img { width: 104px; height: 104px; border-radius: 24px; box-shadow: 0 12px 48px rgba(0,0,0,.5); }
      #vid-title .tt { font-size: 68px; font-weight: 800; letter-spacing: -1px; }
      #vid-title .ts { font-size: 26px; font-weight: 500; color: rgba(255,255,255,.82); }
    `
    document.head.appendChild(style)

    const cursor = document.createElementNS(NS, 'svg')
    cursor.setAttribute('id', 'vid-cursor')
    cursor.setAttribute('viewBox', '0 0 28 28')
    cursor.innerHTML =
      '<path d="M5 3 L5 22 L10 17 L13.5 24 L16.5 22.6 L13 16 L20 16 Z" ' +
      'fill="#fff" stroke="#1a1b1e" stroke-width="1.3" stroke-linejoin="round"/>'
    document.body.appendChild(cursor)

    const cap = document.createElement('div')
    cap.id = 'vid-caption'
    cap.innerHTML = '<div class="t"></div><div class="s"></div>'
    document.body.appendChild(cap)

    const title = document.createElement('div')
    title.id = 'vid-title'
    title.innerHTML = '<img src="/logo.png" alt=""><div class="tt"></div><div class="ts"></div>'
    document.body.appendChild(title)

    // The synthetic cursor follows the real (CDP) mouse.
    window.addEventListener('mousemove', (e) => {
      cursor.style.left = `${e.clientX}px`
      cursor.style.top = `${e.clientY}px`
    }, true)
  })
  await page.mouse.move(RENDER_SIZE.width * 0.5, RENDER_SIZE.height * 0.5)
}
