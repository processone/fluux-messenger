/**
 * Reusable helpers for the Fluux demo video recorder.
 *
 * Playwright drives the real demo (`/demo.html`) deterministically; these
 * helpers add the "promo" polish (a synthetic gliding cursor, click ripples,
 * caption + title cards) and the deterministic "live beats" (typing /
 * incoming messages fired through the demo client on cue).
 *
 * Nothing here is Fluux-specific beyond the selectors/JIDs — the same
 * patterns power scripts/screenshots.ts.
 */

import { type Page, type Locator } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

// ── Constants ──────────────────────────────────────────────────────

export const BASE_URL = 'http://localhost:5173'
export const DEMO_URL = `${BASE_URL}/demo.html?tutorial=false`
/**
 * CSS viewport the app lays out in. Deliberately denser than the 1080p output
 * (same width as the marketing screenshots) so the UI fills the frame instead
 * of leaving wide empty gutters — the app is captured at 2× and scaled to the
 * output size below, keeping the result crisp.
 */
export const RENDER_SIZE = { width: 1280, height: 720 }
/** Output video dimensions. */
export const VIDEO_SIZE = { width: 1920, height: 1080 }

/** Demo JIDs (stable in demo seed data — see apps/fluux/src/demo/). */
export const DOMAIN = 'fluux.chat'
export const SELF_JID = `you@${DOMAIN}`
export const ROOM_JID = `team@conference.${DOMAIN}`

// ── Readiness ──────────────────────────────────────────────────────

/**
 * Open the demo page and paint a dark background immediately, so the brief
 * Vite/React load shows dark (matching the title card) instead of white.
 */
export async function openDemo(page: Page): Promise<void> {
  // Paint the root dark at document-start, before any app code runs, so the
  // multi-second dev module load shows dark (matching the title card) rather
  // than a white flash.
  await page.addInitScript(() => {
    try { document.documentElement.style.background = '#0b0c18' } catch { /* no DOM yet */ }
  })
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    document.documentElement.style.background = '#0b0c18'
    document.body.style.background = '#0b0c18'
  })
  // Cosmetic only — keep transitions intact for smooth motion.
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
 * Call this AFTER covering the screen with the intro card so the load
 * happens off-camera.
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

// ── Polish layers (cursor, ripples, captions, title cards) ─────────

/**
 * Inject the synthetic cursor, click-ripple, caption (lower third) and
 * full-screen title-card overlays. All layers are `pointer-events: none`
 * so real Playwright mouse/keyboard events still drive the React app.
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
        transition: opacity .25s ease;
      }
      .vid-ripple {
        position: fixed; z-index: 2147483646; pointer-events: none;
        width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
        background: rgba(88,101,242,.55); border: 2px solid rgba(88,101,242,.9);
        animation: vidRipple .55s ease-out forwards;
      }
      @keyframes vidRipple {
        from { transform: scale(1); opacity: .9; }
        to   { transform: scale(3.6); opacity: 0; }
      }
      #vid-caption {
        z-index: 2147483640; bottom: 8%; left: 50%;
        transform: translate(-50%, 14px); opacity: 0;
        transition: opacity .45s ease, transform .45s ease;
        max-width: 78%; padding: 16px 26px; border-radius: 16px; text-align: center;
        background: rgba(15,17,21,.74); backdrop-filter: blur(10px);
        box-shadow: 0 10px 40px rgba(0,0,0,.35);
        font-family: Inter, system-ui, -apple-system, sans-serif; color: #fff;
      }
      #vid-caption.show { opacity: 1; transform: translate(-50%, 0); }
      #vid-caption .t { font-size: 32px; font-weight: 700; line-height: 1.15; }
      #vid-caption .s { font-size: 19px; font-weight: 400; opacity: .82; margin-top: 6px; }
      #vid-title {
        z-index: 2147483645; inset: 0; opacity: 0; transition: opacity .6s ease;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 18px; text-align: center;
        background: radial-gradient(120% 120% at 50% 30%, #2b2f63 0%, #14152b 55%, #0b0c18 100%);
        font-family: Inter, system-ui, -apple-system, sans-serif; color: #fff;
      }
      #vid-title.show { opacity: 1; }
      #vid-title img { width: 104px; height: 104px; border-radius: 24px; box-shadow: 0 12px 48px rgba(0,0,0,.5); }
      #vid-title .tt { font-size: 68px; font-weight: 800; letter-spacing: -1px; }
      #vid-title .ts { font-size: 26px; font-weight: 500; color: rgba(255,255,255,.82); }
    `
    document.head.appendChild(style)

    // Synthetic cursor (macOS-style arrow)
    const cursor = document.createElementNS(NS, 'svg')
    cursor.setAttribute('id', 'vid-cursor')
    cursor.setAttribute('viewBox', '0 0 28 28')
    cursor.innerHTML =
      '<path d="M5 3 L5 22 L10 17 L13.5 24 L16.5 22.6 L13 16 L20 16 Z" ' +
      'fill="#fff" stroke="#1a1b1e" stroke-width="1.3" stroke-linejoin="round"/>'
    document.body.appendChild(cursor)

    // Caption (lower third)
    const cap = document.createElement('div')
    cap.id = 'vid-caption'
    cap.innerHTML = '<div class="t"></div><div class="s"></div>'
    document.body.appendChild(cap)

    // Full-screen title card
    const title = document.createElement('div')
    title.id = 'vid-title'
    title.innerHTML = '<img src="/logo.png" alt=""><div class="tt"></div><div class="ts"></div>'
    document.body.appendChild(title)

    // Track real mouse events dispatched by Playwright.
    window.addEventListener('mousemove', (e) => {
      cursor.style.left = `${e.clientX}px`
      cursor.style.top = `${e.clientY}px`
    }, true)
    window.addEventListener('mousedown', (e) => {
      const r = document.createElement('span')
      r.className = 'vid-ripple'
      r.style.left = `${e.clientX}px`
      r.style.top = `${e.clientY}px`
      document.body.appendChild(r)
      r.addEventListener('animationend', () => r.remove())
    }, true)
  })
  // Park the cursor in the middle of the (CSS) viewport initially.
  await page.mouse.move(RENDER_SIZE.width * 0.5, RENDER_SIZE.height * 0.5)
}

/** Show the lower-third caption (fades in, stays until hideCaption). */
export async function showCaption(page: Page, title: string, subtitle = ''): Promise<void> {
  await page.evaluate(({ title, subtitle }) => {
    const el = document.getElementById('vid-caption')
    if (!el) return
    ;(el.querySelector('.t') as HTMLElement).textContent = title
    ;(el.querySelector('.s') as HTMLElement).textContent = subtitle
    el.classList.add('show')
  }, { title, subtitle })
  await page.waitForTimeout(500)
}

/** Hide the lower-third caption. */
export async function hideCaption(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('vid-caption')?.classList.remove('show'))
  await page.waitForTimeout(450)
}

/** Instantly cover the screen with the branded card (no fade-in) — used to
 *  hide the app's initial load behind the intro card. */
export async function coverWithTitle(page: Page, title: string, subtitle: string): Promise<void> {
  await page.evaluate(({ title, subtitle }) => {
    const el = document.getElementById('vid-title')
    if (!el) return
    ;(el.querySelector('.tt') as HTMLElement).textContent = title
    ;(el.querySelector('.ts') as HTMLElement).textContent = subtitle
    const prev = el.style.transition
    el.style.transition = 'none'
    el.classList.add('show')
    // Force reflow, then restore the transition for a smooth fade-out later.
    void el.offsetHeight
    el.style.transition = prev
  }, { title, subtitle })
}

/** Fade the branded card out, revealing the app. */
export async function hideTitleCard(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('vid-title')?.classList.remove('show'))
  await page.waitForTimeout(700)
}

/** Show a full-screen branded title/outro card, hold, then fade out. */
export async function titleCard(page: Page, title: string, subtitle: string, holdMs = 2600): Promise<void> {
  await page.evaluate(({ title, subtitle }) => {
    const el = document.getElementById('vid-title')
    if (!el) return
    ;(el.querySelector('.tt') as HTMLElement).textContent = title
    ;(el.querySelector('.ts') as HTMLElement).textContent = subtitle
    el.classList.add('show')
  }, { title, subtitle })
  await page.waitForTimeout(holdMs)
  await page.evaluate(() => document.getElementById('vid-title')?.classList.remove('show'))
  await page.waitForTimeout(650)
}

// ── Pacing + pointer movement ──────────────────────────────────────

export async function dwell(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms)
}

function asLocator(page: Page, target: Locator | string): Locator {
  return typeof target === 'string' ? page.locator(target) : target
}

/** Glide the cursor to a locator's centre (stepped move = visible motion). */
export async function glideTo(page: Page, target: Locator | string): Promise<{ x: number; y: number }> {
  const loc = asLocator(page, target)
  await loc.scrollIntoViewIfNeeded({ timeout: 15_000 })
  const box = await loc.boundingBox()
  if (!box) throw new Error(`glideTo: target has no bounding box: ${String(target)}`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y, { steps: 28 })
  return { x, y }
}

/**
 * Glide the cursor to a target, then perform a robust `locator.click()`.
 * The glide supplies the visible motion; the real click uses Playwright
 * actionability (auto-wait, retries) so navigation reliably fires. The click
 * still dispatches a mousedown, so the ripple animation plays.
 */
export async function glideClick(page: Page, target: Locator | string, afterMs = 700): Promise<void> {
  const loc = asLocator(page, target)
  await glideTo(page, loc)
  await page.waitForTimeout(240)
  await loc.click({ timeout: 15_000 })
  await page.waitForTimeout(afterMs)
}

// ── Navigation ─────────────────────────────────────────────────────

/** Maps an icon-rail view to its router path (most are 1:1). */
const VIEW_PATHS: Record<string, string> = {
  messages: '/messages',
  rooms: '/rooms',
  directory: '/contacts',
  archive: '/archive',
  events: '/events',
  search: '/search',
  admin: '/admin',
  settings: '/settings',
}

/**
 * Switch the top-level view. The cursor glides to the nav icon and clicks it
 * (visible ripple), but the actual route change goes through the HashRouter —
 * the icon-rail click alone does NOT reliably switch views from every
 * sub-route (verified: a native click on [data-nav="messages"] from inside a
 * room is a no-op), whereas a hash change always works and is deterministic.
 */
export async function navigateTo(page: Page, view: string): Promise<void> {
  const navBtn = page.locator(`[data-nav="${view}"]`)
  try {
    await glideTo(page, navBtn)
    await page.waitForTimeout(220)
    await navBtn.click({ timeout: 5_000 }) // ripple + works for the cases it can
  } catch {
    /* visual nicety only — navigation below is authoritative */
  }
  const path = VIEW_PATHS[view] ?? `/${view}`
  await page.evaluate((p) => { window.location.hash = `#${p}` }, path)
  await page.waitForTimeout(850)
}

export async function selectItem(page: Page, name: string): Promise<void> {
  await glideClick(page, page.getByText(name, { exact: true }).first(), 1000)
}

export async function setTheme(page: Page, themeId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = (window as any).__themeStore
    if (store) store.getState().setActiveTheme(id)
  }, themeId)
  await page.waitForTimeout(700)
}

export async function setColorScheme(page: Page, scheme: 'dark' | 'light'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme })
  await page.waitForTimeout(700)
}

export async function setLanguage(page: Page, langCode: string): Promise<void> {
  await page.evaluate((code) => {
    const i18n = (window as any).__i18n
    if (i18n) void i18n.changeLanguage(code)
  }, langCode)
  await page.waitForTimeout(900)
}

/** Scroll a message/element containing `text` into view (best-effort). */
export async function scrollToText(page: Page, text: string): Promise<void> {
  const el = page.getByText(text, { exact: false }).first()
  if (await el.isVisible().catch(() => false)) {
    await el.scrollIntoViewIfNeeded()
    await page.waitForTimeout(700)
  }
}

// ── Live beats (deterministic, fired through the demo client) ──────

/**
 * Play a typing → incoming-message beat in the currently open 1:1 chat.
 * Returns the injected message id (so a reaction can target it).
 */
export async function beatIncomingChat(
  page: Page,
  opts: { conversationId: string; from: string; body: string; typingMs?: number },
): Promise<string> {
  const typingMs = opts.typingMs ?? 1900
  const id = await page.evaluate(({ conversationId, from, body, typingMs }) => {
    const client = (window as any).__demoClient
    client.stopAnimation()
    const id = `demo-vid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    client.startAnimation([
      { delayMs: 0, action: 'typing', data: { conversationId, jid: from, isTyping: true } },
      { delayMs: typingMs, action: 'stop-typing', data: { conversationId, jid: from, isTyping: false } },
      {
        delayMs: typingMs + 120,
        action: 'message',
        data: {
          message: {
            type: 'chat', id, from, body,
            timestamp: new Date(), isOutgoing: false, conversationId,
          },
        },
      },
    ])
    return id
  }, { conversationId: opts.conversationId, from: opts.from, body: opts.body, typingMs })
  await page.waitForTimeout(typingMs + 700)
  return id
}

/** Add an emoji reaction to a message in a 1:1 chat. */
export async function beatChatReaction(
  page: Page,
  opts: { conversationId: string; messageId: string; reactorJid: string; emojis: string[] },
): Promise<void> {
  await page.evaluate((o) => {
    const client = (window as any).__demoClient
    client.stopAnimation()
    client.startAnimation([{ delayMs: 0, action: 'chat-reaction', data: o }])
  }, opts)
  await page.waitForTimeout(800)
}

/** Play a typing → message beat from a participant in a room. */
export async function beatRoomMessage(
  page: Page,
  opts: { roomJid: string; nick: string; body: string; typingMs?: number },
): Promise<void> {
  const typingMs = opts.typingMs ?? 1700
  await page.evaluate(({ roomJid, nick, body, typingMs }) => {
    const client = (window as any).__demoClient
    client.stopAnimation()
    const id = `demo-vid-room-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    client.startAnimation([
      { delayMs: 0, action: 'room-typing', data: { roomJid, nick, isTyping: true } },
      { delayMs: typingMs, action: 'room-typing', data: { roomJid, nick, isTyping: false } },
      {
        delayMs: typingMs + 120,
        action: 'room-message',
        data: {
          roomJid,
          message: {
            type: 'groupchat', id, from: `${roomJid}/${nick}`, nick, body,
            timestamp: new Date(), isOutgoing: false, roomJid,
          },
          incrementUnread: true,
        },
      },
    ])
  }, { roomJid: opts.roomJid, nick: opts.nick, body: opts.body, typingMs })
  await page.waitForTimeout(typingMs + 700)
}

// ── Output ─────────────────────────────────────────────────────────

/**
 * Convert a WebM (Playwright recordVideo) to an H.264 MP4 at a constant
 * 30fps. No-op with a warning if ffmpeg is unavailable.
 */
export function convertToMp4(webmPath: string, mp4Path: string): void {
  try {
    execFileSync('ffmpeg', [
      '-y', '-i', webmPath,
      // Upscale the dense native capture to the 1080p output (lanczos = sharp).
      '-vf', `scale=${VIDEO_SIZE.width}:${VIDEO_SIZE.height}:flags=lanczos`,
      '-r', '30',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '18',
      '-movflags', '+faststart',
      '-an',
      mp4Path,
    ], { stdio: 'ignore' })
    if (!existsSync(mp4Path)) throw new Error('ffmpeg produced no output')
    // eslint-disable-next-line no-console
    console.log(`  ✓ MP4: ${mp4Path}`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`  ⚠ ffmpeg conversion skipped (${(err as Error).message}). WebM kept: ${webmPath}`)
  }
}
