/**
 * Image rows must not move the content the reader is looking at while they load.
 *
 * Intent (FLM-222: "as the rows resize to load images, the scrolling can appear choppy"):
 * wheeling up through a room of image messages, no frame may move the row at the viewport
 * centre by 1px or more other than through the reader's own scroll or an app scroll write.
 *
 *   jump(frame) = delta(content offset of the row at the viewport centre) - sum(app scroll writes)
 *
 * Runs per frame, unlike invariant-11 in scroll-reading.ts which only checks the settled position.
 */
import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootDemo } from './harness/demoBoot'
import { navigateToStressRoom, settle, STRESS_ROOM_JID } from './harness/scrollHarness'

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/media', import.meta.url))
const FIXTURES = [
  { file: 'portrait-600x800.jpg', width: 600, height: 800 },
  { file: 'landscape-1280x720.jpg', width: 1280, height: 720 },
  { file: 'square-800x800.jpg', width: 800, height: 800 },
  { file: 'wide-1280x400.jpg', width: 1280, height: 400 },
]
const MEDIA_HOST = 'https://upload.media-boxes.test'

type Mode = 'images-with-size' | 'images-without-size' | 'text-only'

async function serveImages(page: Page) {
  const bytes = new Map(FIXTURES.map(f => [f.file, readFileSync(join(FIXTURE_DIR, f.file))]))
  await page.route(`${MEDIA_HOST}/**`, async route => {
    const url = new URL(route.request().url())
    const [, n, file] = url.pathname.split('/')
    // An upload server answers in 120–620 ms, deterministic per message.
    const delay = 120 + ((Number(n) * 97) % 500)
    await new Promise(r => setTimeout(r, delay))
    await route.fulfill({
      status: 200,
      body: bytes.get(file)!,
      headers: { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
    })
  })
}

async function seedRoom(page: Page, mode: Mode) {
  await page.evaluate(({ jid, mode, fixtures, host }) => {
    const scope = window as unknown as {
      __roomStore: { getState: () => any }
      __settingsStore: { getState: () => any }
    }
    scope.__settingsStore.getState().setMediaAutoDownload('always')
    const rs = scope.__roomStore.getState()
    const oldest = rs.messages.get(jid)?.[0]
    if (!oldest) throw new Error('stress room not seeded')
    const count = 160
    const base = oldest.timestamp.getTime()
    const batch = Array.from({ length: count }, (_, k) => {
      const nick = `U0_${k % 6}`
      const isImage = mode !== 'text-only' && k % 2 === 0
      const f = fixtures[k % fixtures.length]
      const url = `${host}/${k}/${f.file}`
      const msg: Record<string, unknown> = {
        type: 'groupchat',
        timestamp: new Date(base - (count - k) * 60_000),
        id: `${jid}::media-${k}`,
        stanzaId: undefined, originId: undefined, occupantId: undefined,
        from: `${jid}/${nick}`,
        nick,
        body: isImage ? url : (k % 3 === 0 ? `message ${k}: a longer line of text that wraps onto a second line so rows vary in height like a real room does.` : `message ${k}`),
        isOutgoing: false,
        roomJid: jid,
      }
      if (isImage) {
        msg.attachment = {
          url, name: f.file, size: 80_000, mediaType: 'image/jpeg',
          ...(mode === 'images-with-size' ? { width: f.width, height: f.height } : {}),
        }
      }
      return msg
    })
    rs.mergeRoomMAMMessages(jid, batch, { first: batch[0].id, last: batch[batch.length - 1].id, count }, false, 'backward')
  }, { jid: STRESS_ROOM_JID, mode, fixtures: FIXTURES, host: MEDIA_HOST })
}

async function installRecorder(page: Page) {
  await page.evaluate(() => {
    const s = document.querySelector('[data-message-list]') as HTMLElement
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
    const read = () => desc.get!.call(s) as number
    const rec = {
      on: false, phase: '', frames: [] as unknown[], writes: [] as unknown[], wheel: [] as unknown[],
      pending: 0, pendingWrites: [] as string[],
    }
    ;(window as any).__mediaScroll = rec
    const note = (kind: string, before: number) => {
      const after = read()
      if (!rec.on) return
      rec.pending += after - before
      rec.pendingWrites.push(`${kind}:${(after - before).toFixed(1)}`)
      rec.writes.push({ t: performance.now(), kind, before, after, phase: rec.phase })
    }
    Object.defineProperty(s, 'scrollTop', {
      configurable: true,
      get() { return read() },
      set(v: number) { const b = read(); desc.set!.call(s, v); note('scrollTop', b) },
    })
    for (const m of ['scrollTo', 'scrollBy', 'scroll'] as const) {
      const orig = (s as any)[m].bind(s)
      ;(s as any)[m] = (...args: unknown[]) => { const b = read(); orig(...args); note(m, b) }
    }
    s.addEventListener('wheel', e => { if (rec.on) rec.wheel.push({ t: performance.now(), dy: e.deltaY, phase: rec.phase }) }, { passive: true, capture: true })
    const sample = (ts: number) => {
      if (rec.on) {
        const sr = s.getBoundingClientRect()
        const st = read()
        const rows: unknown[] = []
        for (const el of Array.from(s.querySelectorAll('[data-index]')) as HTMLElement[]) {
          const msg = el.querySelector('[data-message-id]') as HTMLElement | null
          const r = el.getBoundingClientRect()
          const img = el.querySelector('img.object-contain') as HTMLImageElement | null
          const state = el.querySelector('.animate-spin') ? 'spinner'
            : img ? (img.complete && img.naturalWidth > 0 ? 'decoded' : 'img-pending')
            : msg?.dataset.messageId?.includes('::media-') && Number(msg.dataset.messageId.split('media-')[1]) % 2 === 0 ? 'other' : 'text'
          rows.push([msg?.dataset.messageId ?? `idx${el.dataset.index}`, +(r.top - sr.top + st).toFixed(2), +r.height.toFixed(2), state])
        }
        rec.frames.push({ ts, st, h: s.clientHeight, comp: rec.pending, writes: rec.pendingWrites, phase: rec.phase, rows })
        rec.pending = 0
        rec.pendingWrites = []
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

async function wheelPass(page: Page, phase: string, dy: number, steps: number) {
  await page.evaluate(p => { const r = (window as any).__mediaScroll; r.phase = p; r.on = true }, phase)
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy)
    await page.waitForTimeout(16)
  }
  await page.waitForTimeout(400)
  await page.evaluate(() => { (window as any).__mediaScroll.on = false })
}

interface Jump { writes: string[]; st: number[]; phase: string; frame: number; jump: number; tracked: string; resized: string[] }

function analyse(frames: any[]) {
  const jumps: Jump[] = []
  const byPhase: Record<string, { frames: number; jumps1: number; jumps4: number; max: number; sumAbs: number; userPx: number; longFrames: number; intervals: number[]; tracked: number; decodesAbove: number; scrolled: number }> = {}
  for (let k = 1; k < frames.length; k++) {
    const a = frames[k - 1], b = frames[k]
    if (a.phase !== b.phase) continue
    const ph = (byPhase[b.phase] ??= { frames: 0, jumps1: 0, jumps4: 0, max: 0, sumAbs: 0, userPx: 0, longFrames: 0, intervals: [], tracked: 0, decodesAbove: 0, scrolled: 0 })
    ph.frames++
    const dt = b.ts - a.ts
    ph.intervals.push(dt)
    if (dt > 34) ph.longFrames++
    const prev = new Map<string, any[]>(a.rows.map((r: any[]) => [r[0], r]))
    // Row whose top is nearest the viewport centre in the earlier frame, mounted in both frames.
    let best: any[] | null = null, bestDist = Infinity
    for (const r of b.rows) {
      const p = prev.get(r[0])
      if (!p) continue
      const vTop = p[1] - a.st
      if (vTop < 0 || vTop > a.h) continue
      const d = Math.abs(vTop - a.h / 2)
      if (d < bestDist) { bestDist = d; best = r }
    }
    ph.userPx += Math.abs(b.st - a.st - b.comp)
    ph.scrolled += Math.abs(b.st - a.st)
    // A row above the viewport that went from loading to decoded in this frame.
    for (const r of b.rows) {
      const q = prev.get(r[0])
      if (q && q[3] !== 'decoded' && r[3] === 'decoded' && r[1] + r[2] < b.st) ph.decodesAbove++
    }
    if (!best) continue
    ph.tracked++
    const p = prev.get(best[0])!
    const jump = (best[1] - p[1]) - b.comp
    if (Math.abs(jump) >= 1) {
      ph.jumps1++
      const resized: string[] = []
      for (const r of b.rows) {
        const q = prev.get(r[0])
        if (q && Math.abs(r[2] - q[2]) >= 0.5) resized.push(`${r[0].split('::').pop()} ${q[3]}→${r[3]} ${(r[2] - q[2]).toFixed(1)}px ${r[1] < best[1] ? 'above' : 'below'}`)
      }
      for (const r of b.rows) if (!prev.has(r[0])) resized.push(`mounted ${r[0].split('::').pop()} ${r[3]} h=${r[2]} ${r[1] < best[1] ? 'above' : 'below'}`)
      const nowIds = new Set(b.rows.map((r: any[]) => r[0]))
      for (const r of a.rows) if (!nowIds.has(r[0])) resized.push(`unmounted ${r[0].split('::').pop()} ${r[3]} h=${r[2]} ${r[1] < best[1] ? 'above' : 'below'}`)
      jumps.push({ writes: b.writes, st: [a.st, b.st], phase: b.phase, frame: k, jump: +jump.toFixed(1), tracked: best[0].split('::').pop(), resized })
    }
    if (Math.abs(jump) >= 4) ph.jumps4++
    ph.max = Math.max(ph.max, Math.abs(jump))
    ph.sumAbs += Math.abs(jump)
  }
  const summary = Object.fromEntries(Object.entries(byPhase).map(([k, v]) => {
    const sorted = [...v.intervals].sort((x, y) => x - y)
    return [k, {
      frames: v.frames, jumpFrames: v.jumps1, jumpFramesOver4px: v.jumps4,
      maxJumpPx: +v.max.toFixed(2), totalJumpPx: +v.sumAbs.toFixed(1), readerScrollPx: Math.round(v.userPx), scrolledPx: Math.round(v.scrolled), trackedFrames: v.tracked, decodesAbove: v.decodesAbove,
      longFrames: v.longFrames, p95FrameMs: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1),
    }]
  }))
  return { summary, jumps }
}

for (const mode of ['images-with-size', 'images-without-size', 'text-only'] as Mode[]) {
  test(`scrolling through ${mode} keeps content still on screen`, async ({ page, browserName }, testInfo) => {
    await serveImages(page)
    await bootDemo(page, '/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:40,msgStep:0')
    await seedRoom(page, mode)
    await navigateToStressRoom(page)
    await settle(page)
    await installRecorder(page)
    await page.locator('[data-message-list]').first().hover()
    // 1: first pass up — images fetched from the server while the reader scrolls.
    await wheelPass(page, 'up-cold', -40, 150)
    // 2: back down, then 3: up again over images already fetched (remount from the cache).
    await wheelPass(page, 'down-warm', 40, 150)
    await wheelPass(page, 'up-warm', -40, 150)
    const data = await page.evaluate(() => { const r = (window as any).__mediaScroll; return { frames: r.frames, writes: r.writes, wheel: r.wheel } })
    const { summary, jumps } = analyse(data.frames)
    const wheelPx = Object.fromEntries(['up-cold', 'down-warm', 'up-warm'].map(p =>
      [p, Math.round(data.wheel.filter((w: any) => w.phase === p).reduce((s: number, w: any) => s + Math.abs(w.dy), 0))]))
    const report = { browserName, mode, summary, wheelPx, writes: data.writes.length, jumps: jumps.slice(0, 80) }
    await testInfo.attach('media-report', { body: JSON.stringify(report, null, 1), contentType: 'application/json' })
    // The list must actually have moved and been tracked, or a still page would pass.
    for (const phase of ['up-cold', 'down-warm', 'up-warm']) {
      expect(summary[phase].scrolledPx, `${phase}: list did not move`).toBeGreaterThan(3000)
      expect(summary[phase].trackedFrames, `${phase}: no frames tracked`).toBeGreaterThan(50)
    }
    // Image modes must really exercise the bug: images decode above the viewport while the
    // reader scrolls up for the first time.
    if (mode !== 'text-only') {
      expect(summary['up-cold'].decodesAbove, 'no image decoded above the viewport during up-cold').toBeGreaterThan(0)
    }
    // No frame moves the content the reader is looking at by 1px or more other than through
    // their own scroll.
    for (const phase of Object.keys(summary)) {
      expect(summary[phase].maxJumpPx, `${phase}: content jumped on screen while the reader scrolled: ${JSON.stringify(jumps.filter(j => j.phase === phase).slice(0, 4))}`).toBeLessThan(1)
    }
  })
}
