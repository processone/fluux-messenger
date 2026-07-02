/**
 * Director — a deterministic stepped recorder for the Fluux demo video.
 *
 * Instead of a real-time screencast (locked to CSS resolution), the Director
 * takes ONE native-resolution screenshot per output frame:
 *   - the context renders at the dense RENDER_SIZE with deviceScaleFactor 1.5,
 *     so page.screenshot() yields true 1920×1080 frames (no upscaling);
 *   - script-controlled motion (cursor glides, fades) advances one step per
 *     frame, so it's smooth by construction with no virtual-time fragility;
 *   - the app's own CSS transitions/animations are frozen, so every frame is a
 *     clean, deterministic still;
 *   - static moments are a single screenshot held for a duration.
 * Frames are assembled by ffmpeg (concat + per-frame durations) into an exact,
 * smooth constant-fps MP4 (+ best-effort WebM).
 */

import { type Page, type Locator } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  RENDER_SIZE, DOMAIN, SELF_JID, ROOM_JID, VIEW_PATHS,
  openDemo, waitForAppReady, installPolishLayers,
} from './helpers'

const FPS = 30
const FRAME_SEC = 1 / FPS

const READ_BEAT = 1700 // ms a caption holds before the scene's feature action fires
const ABSORB = 1800    // ms to hold on a result before clearing the caption
const VEIL_MAX = 0.55  // peak opacity of the scene-transition veil
const VEIL_IN = 5      // frames to dip the veil in
const VEIL_OUT = 7     // frames to lift the veil out

interface Frame { file: string; durationSec: number }

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

export class Director {
  readonly page: Page
  private readonly dir: string
  private frames: Frame[] = []
  private n = 0
  private cursor = { x: RENDER_SIZE.width / 2, y: RENDER_SIZE.height / 2 }

  constructor(page: Page, framesDir: string) {
    this.page = page
    this.dir = resolve(framesDir)
  }

  // ── frame capture ────────────────────────────────────────────────

  private async snap(durationSec: number): Promise<void> {
    const buf = await this.page.screenshot({ type: 'jpeg', quality: 92 })
    const file = join(this.dir, `f_${String(this.n++).padStart(5, '0')}.jpg`)
    writeFileSync(file, buf)
    this.frames.push({ file, durationSec })
  }

  /** Capture one frame and hold it for `ms` (a static moment — one screenshot). */
  async hold(ms: number): Promise<void> {
    await this.snap(ms / 1000)
  }

  /** Capture `count` frames (1/FPS each), running `step(i)` before each. */
  private async steps(count: number, step: (i: number) => Promise<void> | void): Promise<void> {
    for (let i = 0; i < count; i++) {
      await step(i)
      await this.snap(FRAME_SEC)
    }
  }

  private setTitle(_title: string, sub: string): Promise<void> {
    return this.page.evaluate((sub) => {
      const el = document.getElementById('vid-title')
      if (!el) return
      const s = el.querySelector('.ts') as HTMLElement | null
      if (s) s.textContent = sub
    }, sub)
  }
  private setOpacity(id: string, o: number): Promise<void> {
    return this.page.evaluate(({ id, o }) => {
      const el = document.getElementById(id)
      if (el) el.style.opacity = String(o)
    }, { id, o })
  }

  // ── setup / intro / outro ────────────────────────────────────────

  /** Boot the demo off-camera, behind the (opaque) intro card. */
  async setup(introTitle: string, introSub: string): Promise<void> {
    rmSync(this.dir, { recursive: true, force: true })
    mkdirSync(this.dir, { recursive: true })
    await openDemo(this.page)
    await installPolishLayers(this.page)
    // Freeze app CSS transitions/animations: every screenshot is then a clean,
    // deterministic still. Motion comes from the scripted cursor + state steps.
    await this.page.addStyleTag({
      content: `*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; }`,
    })
    await this.setTitle(introTitle, introSub)
    await this.setOpacity('vid-title', 1) // cover the load
    await waitForAppReady(this.page)
  }

  /** Hold the intro card, then fade it out to reveal the app. */
  async intro(holdMs: number): Promise<void> {
    await this.hold(holdMs)
    await this.steps(12, (i) => this.setOpacity('vid-title', 1 - (i + 1) / 12))
  }

  /** Fade the branded card in, hold, fade out. */
  async outro(title: string, sub: string, holdMs: number): Promise<void> {
    await this.setTitle(title, sub)
    await this.steps(12, (i) => this.setOpacity('vid-title', (i + 1) / 12))
    await this.hold(holdMs)
    await this.steps(10, (i) => this.setOpacity('vid-title', 1 - (i + 1) / 10))
  }

  // ── captions ─────────────────────────────────────────────────────

  async caption(title: string, sub = ''): Promise<void> {
    await this.page.evaluate(({ title, sub }) => {
      const el = document.getElementById('vid-caption')
      if (!el) return
      ;(el.querySelector('.t') as HTMLElement).textContent = title
      ;(el.querySelector('.s') as HTMLElement).textContent = sub
    }, { title, sub })
    await this.steps(8, (i) => {
      const o = (i + 1) / 8
      return this.page.evaluate((o) => {
        const el = document.getElementById('vid-caption')
        if (el) { el.style.opacity = String(o); el.style.transform = `translate(0, ${10 * (1 - o)}px)` }
      }, o)
    })
    await this.hold(READ_BEAT) // read before the feature moves
  }

  async clearCaption(): Promise<void> {
    await this.steps(6, (i) => this.setOpacity('vid-caption', 1 - (i + 1) / 6))
  }

  // ── pacing ───────────────────────────────────────────────────────

  async dwell(ms: number): Promise<void> {
    await this.hold(ms)
  }

  /** Hold on the current frame long enough for the result to land. */
  async absorb(): Promise<void> {
    await this.hold(ABSORB)
  }

  /** Dip a dark veil, run `fn` while covered (a settle beat), then lift it. */
  async crossfade(fn: () => Promise<void>): Promise<void> {
    await this.steps(VEIL_IN, (i) => this.setOpacity('vid-veil', VEIL_MAX * ((i + 1) / VEIL_IN)))
    await fn()
    await this.steps(VEIL_OUT, (i) => this.setOpacity('vid-veil', VEIL_MAX * (1 - (i + 1) / VEIL_OUT)))
  }

  // ── pointer + clicks ─────────────────────────────────────────────

  private locate(target: Locator | string): Locator {
    return typeof target === 'string' ? this.page.locator(target) : target
  }

  private async moveCursor(x: number, y: number): Promise<void> {
    await this.page.mouse.move(x, y)
    this.cursor = { x, y }
  }

  /** Glide the cursor to a locator's centre, one step per frame (eased). */
  async glideTo(target: Locator | string, frames = 22): Promise<{ x: number; y: number }> {
    const loc = this.locate(target)
    await loc.scrollIntoViewIfNeeded({ timeout: 15_000 })
    const box = await loc.boundingBox()
    if (!box) throw new Error(`glideTo: no bounding box for ${String(target)}`)
    const tx = box.x + box.width / 2
    const ty = box.y + box.height / 2
    const { x: sx, y: sy } = this.cursor
    await this.steps(frames, (i) => {
      const t = easeInOut((i + 1) / frames)
      return this.moveCursor(sx + (tx - sx) * t, sy + (ty - sy) * t)
    })
    return { x: tx, y: ty }
  }

  /** Glide to a target and click it; hold briefly to capture the result. */
  async glideClick(target: Locator | string, holdMs = 700): Promise<void> {
    const loc = this.locate(target)
    await this.glideTo(loc)
    await loc.click({ timeout: 15_000 })
    await this.hold(holdMs)
  }

  // ── navigation ───────────────────────────────────────────────────

  /** Switch the top-level view: glide to the nav icon, then hash-navigate
   *  (authoritative — the icon click alone doesn't switch from every route). */
  async navigateTo(view: string): Promise<void> {
    const path = VIEW_PATHS[view] ?? `/${view}`
    // If we're already on this view (e.g. the command palette just jumped us
    // into a room), don't replay the icon-rail click — the list is already
    // shown, so the click would be a redundant gesture on camera.
    const alreadyHere = await this.page.evaluate(
      (p) => window.location.hash === `#${p}` || window.location.hash.startsWith(`#${p}/`),
      path,
    )
    if (alreadyHere) return
    const navBtn = this.page.locator(`[data-nav="${view}"]`)
    try {
      await this.glideTo(navBtn, 16)
      await navBtn.click({ timeout: 5_000 })
    } catch { /* visual nicety; hash nav below is authoritative */ }
    await this.page.evaluate((p) => { window.location.hash = `#${p}` }, path)
    await this.page.waitForTimeout(400)
    await this.hold(700)
  }

  async selectItem(name: string): Promise<void> {
    await this.glideClick(this.page.getByText(name, { exact: true }).first(), 1000)
  }

  // ── keyboard ─────────────────────────────────────────────────────

  async press(key: string, holdMs = 650): Promise<void> {
    await this.page.keyboard.press(key)
    await this.page.waitForTimeout(60)
    await this.hold(holdMs)
  }

  async typeText(text: string, perCharMs = 140): Promise<void> {
    for (const ch of text) {
      await this.page.keyboard.type(ch)
      await this.page.waitForTimeout(30)
      await this.hold(perCharMs)
    }
  }

  // ── theming / locale ─────────────────────────────────────────────

  async setTheme(themeId: string, holdMs = 1200): Promise<void> {
    await this.page.evaluate((id) => {
      const s = (window as any).__themeStore
      if (s) s.getState().setActiveTheme(id)
    }, themeId)
    await this.page.waitForTimeout(60)
    await this.hold(holdMs)
  }

  async setColorScheme(scheme: 'dark' | 'light', holdMs = 1200): Promise<void> {
    await this.page.emulateMedia({ colorScheme: scheme })
    await this.page.waitForTimeout(60)
    await this.hold(holdMs)
  }

  async setLanguage(code: string, holdMs = 2500): Promise<void> {
    await this.page.evaluate((c) => {
      const i18n = (window as any).__i18n
      if (i18n) void i18n.changeLanguage(c)
    }, code)
    await this.page.waitForTimeout(120)
    await this.hold(holdMs)
  }

  // ── scrolling ────────────────────────────────────────────────────

  async scrollTo(text: string, holdMs = 2000): Promise<void> {
    const el = this.page.getByText(text, { exact: false }).first()
    if (await el.isVisible().catch(() => false)) {
      await el.scrollIntoViewIfNeeded()
      await this.page.waitForTimeout(80)
    }
    await this.hold(holdMs)
  }

  async scrollLocator(target: Locator | string, holdMs = 2000): Promise<void> {
    const loc = this.locate(target)
    if (await loc.isVisible().catch(() => false)) {
      await loc.scrollIntoViewIfNeeded()
      await this.page.waitForTimeout(80)
    }
    await this.hold(holdMs)
  }

  // ── live beats (state injected directly, then held) ──────────────

  private fire(steps: unknown): Promise<void> {
    return this.page.evaluate((s) => {
      const c = (window as any).__demoClient
      c.stopAnimation()
      c.startAnimation(s)
    }, steps)
  }

  /** Typing indicator → incoming message in the open 1:1 chat. Returns msg id. */
  async typeBeat(opts: { conversationId: string; from: string; body: string }): Promise<string> {
    const id = `demo-vid-${this.n}`
    await this.fire([{ delayMs: 0, action: 'typing', data: { conversationId: opts.conversationId, jid: opts.from, isTyping: true } }])
    await this.page.waitForTimeout(80)
    await this.hold(1100) // "typing…"
    await this.fire([
      { delayMs: 0, action: 'stop-typing', data: { conversationId: opts.conversationId, jid: opts.from, isTyping: false } },
      { delayMs: 0, action: 'message', data: { message: { type: 'chat', id, from: opts.from, body: opts.body, timestamp: new Date(), isOutgoing: false, conversationId: opts.conversationId } } },
    ])
    await this.page.waitForTimeout(80)
    await this.hold(1300) // message shown
    return id
  }

  async chatReaction(opts: { conversationId: string; messageId: string; reactorJid: string; emojis: string[] }): Promise<void> {
    await this.fire([{ delayMs: 0, action: 'chat-reaction', data: opts }])
    await this.page.waitForTimeout(80)
    await this.hold(1200)
  }

  /** Typing → message from a room participant (optionally a quoted reply). Returns the message id. */
  async roomBeat(opts: {
    roomJid: string; nick: string; body: string
    id?: string
    replyTo?: { id: string; to: string; fallbackBody: string }
  }): Promise<string> {
    const id = opts.id ?? `demo-vid-room-${this.n}`
    await this.fire([{ delayMs: 0, action: 'room-typing', data: { roomJid: opts.roomJid, nick: opts.nick, isTyping: true } }])
    await this.page.waitForTimeout(80)
    await this.hold(1000)
    await this.fire([
      { delayMs: 0, action: 'room-typing', data: { roomJid: opts.roomJid, nick: opts.nick, isTyping: false } },
      { delayMs: 0, action: 'room-message', data: {
        roomJid: opts.roomJid,
        message: {
          type: 'groupchat', id, from: `${opts.roomJid}/${opts.nick}`, nick: opts.nick,
          body: opts.body, timestamp: new Date(), isOutgoing: false, roomJid: opts.roomJid,
          ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
        },
        incrementUnread: true,
      } },
    ])
    await this.page.waitForTimeout(80)
    await this.hold(1300)
    return id
  }

  /** Inject a completed outgoing message that carries an image/file attachment. */
  async attachmentBeat(opts: {
    conversationId: string; body: string
    attachment: { url: string; name: string; mediaType: string; size: number; width?: number; height?: number }
  }): Promise<void> {
    const id = `demo-vid-file-${this.n}`
    await this.fire([{ delayMs: 0, action: 'message', data: {
      message: {
        type: 'chat', id, from: SELF_JID, body: opts.body,
        timestamp: new Date(), isOutgoing: true, conversationId: opts.conversationId,
        attachment: opts.attachment,
      },
    } }])
    await this.page.waitForTimeout(80)
    await this.hold(1400)
  }

  /** XEP-0308: correct a message in place (shows the "edited" indicator). */
  async editMessage(opts: { conversationId: string; messageId: string; body: string }): Promise<void> {
    await this.fire([{ delayMs: 0, action: 'message-updated', data: {
      conversationId: opts.conversationId, messageId: opts.messageId,
      updates: { body: opts.body, isEdited: true },
    } }])
    await this.page.waitForTimeout(80)
    await this.hold(1300)
  }

  /** XEP-0424: retract (unsend) a message. */
  async retractMessage(opts: { conversationId: string; messageId: string }): Promise<void> {
    await this.fire([{ delayMs: 0, action: 'message-updated', data: {
      conversationId: opts.conversationId, messageId: opts.messageId,
      updates: { isRetracted: true, retractedAt: new Date() },
    } }])
    await this.page.waitForTimeout(80)
    await this.hold(1500)
  }

  /** A roster presence change (e.g. a contact coming online). */
  async presence(opts: { fullJid: string; show: 'chat' | 'away' | 'xa' | 'dnd' | null; priority?: number; client?: string }): Promise<void> {
    await this.fire([{ delayMs: 0, action: 'presence', data: {
      fullJid: opts.fullJid, show: opts.show, priority: opts.priority ?? 5, client: opts.client ?? 'Fluux',
    } }])
    await this.page.waitForTimeout(80)
    await this.hold(900)
  }

  // ── assembly ─────────────────────────────────────────────────────

  /** Assemble the captured frames into a constant-fps MP4 (+ best-effort WebM). */
  finish(outBase: string): { frames: number; seconds: number } {
    if (this.frames.length < 2) throw new Error(`too few frames (${this.frames.length})`)
    const lines: string[] = []
    let total = 0
    for (const f of this.frames) {
      lines.push(`file '${f.file}'`)
      lines.push(`duration ${f.durationSec.toFixed(4)}`)
      total += f.durationSec
    }
    lines.push(`file '${this.frames[this.frames.length - 1].file}'`) // concat quirk
    const list = join(this.dir, 'frames.txt')
    writeFileSync(list, lines.join('\n'))

    const input = ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS}`]
    execFileSync('ffmpeg', [
      ...input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
      '-movflags', '+faststart', '-an', `${outBase}.mp4`,
    ], { stdio: 'ignore' })
    try {
      execFileSync('ffmpeg', [
        ...input, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p',
        '-crf', '32', '-b:v', '0', '-deadline', 'good', '-cpu-used', '5', '-an', `${outBase}.webm`,
      ], { stdio: 'ignore' })
    } catch { /* webm best-effort */ }

    return { frames: this.n, seconds: total }
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}

export { DOMAIN, SELF_JID, ROOM_JID }
