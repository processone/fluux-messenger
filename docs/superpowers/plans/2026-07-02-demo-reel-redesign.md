# Demo Reel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the demo reel (`npm run demo:video:reel`) slower and readable, show features as live interactions, add cinematic scene transitions, cover replies/rich-text + file sharing + edit/retract, and brand the intro/outro with the Aurora logo lockup.

**Architecture:** Keep the deterministic stepped recorder unchanged (Director captures one native 1920×1080 frame per step; ffmpeg concatenates at 30fps). Add three pacing primitives to the Director (read-beat captions, `crossfade()` transitions, absorb-holds) and several live-beat helpers (room reply, outgoing attachment, edit, retract, presence). Re-author `scripts/video/storyboard.ts` into a consistent per-scene rhythm. Swap the intro/outro title card to the inlined lockup SVG.

**Tech Stack:** TypeScript, Playwright (`@playwright/test`), ffmpeg, the demo mode (`DemoClient` state injection via `page.evaluate(() => __demoClient.startAnimation(steps))`).

## Global Constraints

- Scripts-only change. Do **not** modify product code under `apps/fluux/src/**` or `packages/fluux-sdk/src/**`. Only `scripts/video/*.ts` change.
- Ship **silent** (ffmpeg keeps `-an`). No audio track.
- **Never show or claim read receipts** — not implemented in the product.
- Determinism: no `Date.now()`/`Math.random()`/real-timer-driven app animation as a capture source. All motion is frame-stepped; all demo state is injected synchronously through the existing `fire()` path. (`new Date()` inside an injected message payload is fine — that mirrors the existing `typeBeat`/`roomBeat` helpers and is serialized to the page.)
- Runtime target for the reel: **~2:10–2:30**.
- Reel scenes are marked `variant: 'reel'` so they also appear in the **full** tour; do not remove the full-only scenes (`poll-code`, `whisper`, `encryption-settings`, `search`, `i18n`, `admin`).
- No Claude footer in commit messages.

## File Structure

- `scripts/video/director.ts` — capture engine + primitives. Add pacing constants, `crossfade()`, read-beat inside `caption()`, `absorb()`, and live-beat helpers (`roomBeat` extended with `id`/`replyTo`, `attachmentBeat`, `editMessage`, `retractMessage`, `presence`). Adjust `setTitle` to drive tagline only.
- `scripts/video/helpers.ts` — constants + page bootstrap + overlay injection. Add the `#vid-veil` layer and inline the lockup SVG into `#vid-title`.
- `scripts/video/storyboard.ts` — re-authored scene list (reordered; new `replies-richtext`, `file-sharing`, `edit-retract` scenes).
- `scripts/video/record.ts` — longer intro/outro holds.

Because a rendered video has no unit-test harness, the verification for each code task is **`npx tsc`** (catches type errors the Playwright esbuild transpile would silently ignore) plus a **recorded render + frame inspection** at two checkpoints. This is stated honestly per task.

Pre-flight (run once before Task 1, not a code change): confirm the toolchain is present.

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/hungry-chandrasekhar-031b8d
node -e "require('fs').accessSync('assets/readme/fluux-logo.svg')" && echo "lockup present"
which ffmpeg && npx playwright install chromium >/dev/null 2>&1 && echo "playwright chromium ready"
npm run build:sdk   # the recorder imports @fluux/sdk types; worktree needs the built dist
```

---

### Task 1: Pacing primitives — read-beat captions, crossfade transitions, absorb-holds

**Files:**
- Modify: `scripts/video/director.ts` (constants near top; `caption()`; new `crossfade()` and `absorb()`)
- Modify: `scripts/video/helpers.ts` (add `#vid-veil` layer style + element in `installPolishLayers`)

**Interfaces:**
- Consumes: existing `Director.snap`, `Director.hold`, `Director.steps`, `Director.setOpacity`.
- Produces (used by Tasks 3–4):
  - `caption(title: string, sub?: string): Promise<void>` — now fades the lower-third in **and holds `READ_BEAT` ms before returning**.
  - `crossfade(fn: () => Promise<void>): Promise<void>` — dip veil → run `fn` (covered) → lift veil.
  - `absorb(): Promise<void>` — hold `ABSORB` ms on the current frame.

- [ ] **Step 1: Add the veil layer to the overlay injection**

In `scripts/video/helpers.ts`, inside `installPolishLayers`'s injected `style.textContent`, add a `#vid-veil` rule alongside the existing `#vid-cursor, #vid-caption, #vid-title` block. Put it **below** the title card (z-index 2147483643 < title's 2147483645) so scene transitions never cover the intro/outro card:

```css
#vid-veil {
  z-index: 2147483643; inset: 0; opacity: 0;
  background: #0b0c18;
}
```

Add `#vid-veil` to the shared `position: fixed; pointer-events: none;` selector list:

```css
#vid-cursor, #vid-caption, #vid-title, #vid-veil { position: fixed; pointer-events: none; }
```

And append the element next to the caption/title elements in the same `page.evaluate`:

```javascript
const veil = document.createElement('div')
veil.id = 'vid-veil'
document.body.appendChild(veil)
```

- [ ] **Step 2: Add pacing constants + `crossfade`/`absorb` to the Director**

In `scripts/video/director.ts`, add constants just below the existing `FPS`/`FRAME_SEC` lines:

```typescript
const READ_BEAT = 1700 // ms a caption holds before the scene's feature action fires
const ABSORB = 1800    // ms to hold on a result before clearing the caption
const VEIL_MAX = 0.55  // peak opacity of the scene-transition veil
const VEIL_IN = 5      // frames to dip the veil in
const VEIL_OUT = 7     // frames to lift the veil out
```

Add these methods to the `Director` class (place them near `dwell`, in the "pacing" section):

```typescript
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
```

- [ ] **Step 3: Give `caption()` a built-in read-beat**

In `scripts/video/director.ts`, at the end of the existing `caption()` method (after the fade-in `steps(8, …)` block), append a hold so the caption is readable before any feature action:

```typescript
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
```

- [ ] **Step 4: Type-check the scripts**

Run:

```bash
npx tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target esnext --types node \
  scripts/video/director.ts scripts/video/helpers.ts
```

Expected: no errors. (If it complains about missing `@playwright/test`/`@fluux/sdk` type roots, fall back to `npm run typecheck` which uses the repo tsconfig — expected: PASS, no new errors.)

- [ ] **Step 5: Commit**

```bash
git add scripts/video/director.ts scripts/video/helpers.ts
git commit -m "feat(video): add read-beat captions, crossfade transitions, absorb holds"
```

---

### Task 2: Brand the intro/outro with the inlined Aurora lockup

**Files:**
- Modify: `scripts/video/helpers.ts` (import fs; read lockup SVG; swap `#vid-title` markup + styles)
- Modify: `scripts/video/director.ts` (`setTitle` drives tagline only)
- Modify: `scripts/video/record.ts` (longer intro/outro holds)

**Interfaces:**
- Consumes: `assets/readme/fluux-logo.svg` (self-contained outlined vector paths — no font/network dependency).
- Produces: intro/outro cards show the lockup as the hero, with a tagline line below driven by the existing `setTitle(_title, sub)` subtitle slot.

- [ ] **Step 1: Read the lockup SVG at module load**

At the top of `scripts/video/helpers.ts` add the imports and read the file (fail-fast if missing — a blank card must never ship):

```typescript
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Aurora logo lockup (bubble + wordmark), inlined so it renders with no font/network dependency. */
const LOCKUP_SVG = readFileSync(resolve('assets/readme/fluux-logo.svg'), 'utf8')
```

- [ ] **Step 2: Swap the title-card markup and styles**

In `installPolishLayers`, replace the `#vid-title` **style rules** (the `#vid-title img`, `.tt`, `.ts` block) with lockup-centric ones. Change the existing:

```css
      #vid-title img { width: 104px; height: 104px; border-radius: 24px; box-shadow: 0 12px 48px rgba(0,0,0,.5); }
      #vid-title .tt { font-size: 68px; font-weight: 800; letter-spacing: -1px; }
      #vid-title .ts { font-size: 26px; font-weight: 500; color: rgba(255,255,255,.82); }
```

to:

```css
      #vid-title .lockup svg { width: 380px; height: auto; filter: drop-shadow(0 12px 48px rgba(0,0,0,.5)); }
      #vid-title .ts { font-size: 26px; font-weight: 500; color: rgba(255,255,255,.82); }
```

Then change the title **element** construction. Replace:

```javascript
    const title = document.createElement('div')
    title.id = 'vid-title'
    title.innerHTML = '<img src="/logo.png" alt=""><div class="tt"></div><div class="ts"></div>'
    document.body.appendChild(title)
```

with (note `LOCKUP_SVG` is interpolated from the Node scope into the `page.evaluate` via an argument — see Step 3):

```javascript
    const title = document.createElement('div')
    title.id = 'vid-title'
    title.innerHTML = `<div class="lockup">${lockupSvg}</div><div class="ts"></div>`
    document.body.appendChild(title)
```

- [ ] **Step 3: Pass the SVG markup into the page**

`installPolishLayers` calls `page.evaluate(() => { … })` with no args. Change it to pass `LOCKUP_SVG` in, and add the matching parameter to the callback:

```typescript
export async function installPolishLayers(page: Page): Promise<void> {
  await page.evaluate((lockupSvg) => {
    if (document.getElementById('vid-cursor')) return
    // … existing body, now using `lockupSvg` in the title element …
  }, LOCKUP_SVG)
  await page.mouse.move(RENDER_SIZE.width * 0.5, RENDER_SIZE.height * 0.5)
}
```

- [ ] **Step 4: Make `setTitle` drive the tagline only**

In `scripts/video/director.ts`, the `.tt` element no longer exists. Update `setTitle` so it only writes the subtitle (keep the two-arg signature so callers in `setup`/`intro`/`outro` don't change; the title arg is now ignored):

```typescript
private setTitle(_title: string, sub: string): Promise<void> {
  return this.page.evaluate((sub) => {
    const el = document.getElementById('vid-title')
    if (!el) return
    const s = el.querySelector('.ts') as HTMLElement | null
    if (s) s.textContent = sub
  }, sub)
}
```

- [ ] **Step 5: Lengthen the intro/outro holds**

In `scripts/video/record.ts`, give the brand cards more air:

```typescript
    await d.setup('Fluux Messenger', 'A modern XMPP client')
    await d.intro(2200)
    for (const scene of scenesFor(variant)) {
      // eslint-disable-next-line no-console
      console.log(`  ▶ ${variant}: ${scene.id}`)
      await scene.run(d)
    }
    await d.outro('Fluux Messenger', 'Open. Secure. Yours.', 3200)
```

- [ ] **Step 6: Type-check**

Run:

```bash
npx tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target esnext --types node \
  scripts/video/director.ts scripts/video/helpers.ts scripts/video/record.ts
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add scripts/video/director.ts scripts/video/helpers.ts scripts/video/record.ts
git commit -m "feat(video): brand intro/outro with inlined Aurora logo lockup"
```

---

### Task 3: Live-beat helpers for the new scenes

**Files:**
- Modify: `scripts/video/director.ts` (extend `roomBeat`; add `attachmentBeat`, `editMessage`, `retractMessage`, `presence`)

**Interfaces:**
- Consumes: existing private `fire(steps)`, `SELF_JID`, `DOMAIN`.
- Produces (used by Task 4):
  - `roomBeat(opts: { roomJid: string; nick: string; body: string; id?: string; replyTo?: { id: string; to: string; fallbackBody: string } }): Promise<string>` — typing → room message (optionally a quoted reply); returns the message id.
  - `attachmentBeat(opts: { conversationId: string; body: string; attachment: { url: string; name: string; mediaType: string; size: number; width?: number; height?: number } }): Promise<void>` — inject a completed outgoing message that carries an image/file attachment.
  - `editMessage(opts: { conversationId: string; messageId: string; body: string }): Promise<void>` — XEP-0308 correction; sets `isEdited`.
  - `retractMessage(opts: { conversationId: string; messageId: string }): Promise<void>` — XEP-0424 retraction.
  - `presence(opts: { fullJid: string; show: 'chat' | 'away' | 'xa' | 'dnd' | null; priority?: number; client?: string }): Promise<void>` — a roster presence change (e.g. a contact coming online).

- [ ] **Step 1: Extend `roomBeat` to accept an id and a reply**

Replace the existing `roomBeat` in `scripts/video/director.ts` with this backward-compatible version (existing callers pass no `id`/`replyTo`, so they are unaffected):

```typescript
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
```

- [ ] **Step 2: Add `attachmentBeat`, `editMessage`, `retractMessage`, `presence`**

Add these methods in the "live beats" section of `scripts/video/director.ts` (after `roomBeat`):

```typescript
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
```

- [ ] **Step 3: Type-check**

Run:

```bash
npx tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target esnext --types node \
  scripts/video/director.ts
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/video/director.ts
git commit -m "feat(video): add reply/attachment/edit/retract/presence beat helpers"
```

---

### Task 4: Re-author the storyboard (rhythm + reorder + new scenes)

**Files:**
- Modify: `scripts/video/storyboard.ts` (replace the reel scenes; keep full-only scenes)

**Interfaces:**
- Consumes: `Director.crossfade`, `caption` (read-beat), `absorb`, `roomBeat`, `attachmentBeat`, `editMessage`, `retractMessage`, `presence`, plus existing `typeBeat`, `chatReaction`, `navigateTo`, `selectItem`, `press`, `typeText`, `glideClick`, `setTheme`, `setColorScheme`.
- Produces: the reel scene sequence; every scene follows *crossfade in → caption(read-beat) → live interaction → absorb → clearCaption*.

- [ ] **Step 1: Replace the reel scenes in the storyboard array**

In `scripts/video/storyboard.ts`, replace the reel-variant scene objects (`messaging`, `command-palette`, `rooms`, `encryption`, `themes`) with the set below, **in this order**, and leave the `full`-only scenes (`poll-code`, `whisper`, `encryption-settings`, `search`, `i18n`, `admin`) untouched after them. `scenesFor('reel')` filters by variant, so ordering in the array is the on-screen order.

```typescript
  // 1 — Direct messaging + typing + reaction (reel)
  {
    id: 'messaging',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('messages'); await d.selectItem('Emma Wilson') })
      await d.caption('Fast, modern messaging', 'Typing indicators, reactions & replies — built in')
      const msgId = await d.typeBeat({ conversationId: `emma@${DOMAIN}`, from: `emma@${DOMAIN}`, body: 'Perfect — see you at 4! 🎉' })
      await d.chatReaction({ conversationId: `emma@${DOMAIN}`, messageId: msgId, reactorJid: SELF_JID, emojis: ['👍'] })
      await d.absorb()
      await d.clearCaption()
    },
  },

  // 2 — Replies & rich text / markdown (reel)
  {
    id: 'replies-richtext',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('rooms'); await d.selectItem('Team Chat') })
      await d.caption('Replies & rich text', 'Markdown, code blocks & quoted replies')
      const codeId = 'demo-vid-code'
      await d.roomBeat({
        roomJid: ROOM_JID, nick: 'Sophia', id: codeId,
        body: 'Optimized the XML parser:\n\n```rust\npub fn parse(input: &[u8]) -> Result<Stanza, Error> {\n    let mut r = Reader::from_reader(input);\n    r.config_mut().trim_text(true);\n    Stanza::read(&mut r)\n}\n```\n\n3× faster than before 🏎️',
      })
      await d.absorb()
      await d.roomBeat({
        roomJid: ROOM_JID, nick: 'Emma',
        body: 'Nice catch — that explains the heap growth I saw in the profiler',
        replyTo: { id: codeId, to: `${ROOM_JID}/Sophia`, fallbackBody: 'Optimized the XML parser' },
      })
      await d.absorb()
      await d.clearCaption()
    },
  },

  // 3 — File & image sharing (reel)
  {
    id: 'file-sharing',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('messages'); await d.selectItem('Emma Wilson') })
      await d.caption('Share files & images', 'Images, PDFs & voice notes — with inline previews')
      await d.attachmentBeat({
        conversationId: `emma@${DOMAIN}`,
        body: 'Here’s the latest mockup 👇',
        attachment: { url: './demo/screenshot-chat-dark.png', name: 'mockup-v2.png', mediaType: 'image/png', size: 384_000, width: 1280, height: 800 },
      })
      await d.absorb()
      await d.clearCaption()
    },
  },

  // 4 — Edit & retraction (reel)
  {
    id: 'edit-retract',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('messages'); await d.selectItem('Emma Wilson') })
      await d.caption('Edit & unsend', 'Fix a typo or retract a message (XEP-0308 / XEP-0424)')
      const editId = await d.typeBeat({ conversationId: `emma@${DOMAIN}`, from: `emma@${DOMAIN}`, body: 'Lunch at 12:30 sharp!' })
      await d.absorb()
      await d.editMessage({ conversationId: `emma@${DOMAIN}`, messageId: editId, body: 'Lunch at 1:00 sharp!' })
      await d.absorb()
      const dropId = await d.typeBeat({ conversationId: `emma@${DOMAIN}`, from: `emma@${DOMAIN}`, body: 'Wrong chat, ignore that 🙈' })
      await d.absorb()
      await d.retractMessage({ conversationId: `emma@${DOMAIN}`, messageId: dropId })
      await d.absorb()
      await d.clearCaption()
    },
  },

  // 5 — Command palette (reel)
  {
    id: 'command-palette',
    variant: 'reel',
    run: async (d) => {
      await d.caption('Jump anywhere', 'Command palette — ⌘K')
      await d.press('Meta+k', 800)
      await d.typeText('design')
      await d.dwell(900)
      await d.glideClick(d.page.getByText('Design Review', { exact: true }).first(), 1500)
      await d.clearCaption()
    },
  },

  // 6 — Group rooms + presence + members (reel)
  {
    id: 'rooms-presence',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('rooms'); await d.selectItem('Team Chat') })
      await d.caption('Group chat & rooms', 'MUC rooms with presence, roles & members')
      const membersBtn = d.page.locator('button[aria-label="Show members"]')
      if (await membersBtn.isVisible().catch(() => false)) await d.glideClick(membersBtn, 1000)
      await d.presence({ fullJid: `sophia@${DOMAIN}/laptop`, show: null })
      await d.roomBeat({ roomJid: ROOM_JID, nick: 'James', body: 'Pushed the fix — CI is green ✅' })
      await d.absorb()
      await d.clearCaption()
    },
  },

  // 7 — End-to-end encryption (reel)
  {
    id: 'encryption',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('messages'); await d.selectItem('Ava Martinez') })
      await d.caption('End-to-end encryption', 'OpenPGP with verified / TOFU trust states')
      await d.absorb()
      await d.dwell(1400)
      await d.clearCaption()
    },
  },

  // 8 — Themes & dark/light (reel)
  {
    id: 'themes',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('messages'); await d.selectItem('Emma Wilson') })
      await d.caption('Make it yours', 'Light & dark, plus curated themes')
      await d.setColorScheme('light', 1400)
      await d.setTheme('nord', 1300)
      await d.setTheme('dracula', 1300)
      await d.setTheme('fluux')
      await d.setColorScheme('dark', 900)
      await d.clearCaption()
    },
  },
```

- [ ] **Step 2: Confirm the full-only scenes still compile against the new order**

The `full`-only scenes (`poll-code`, `whisper`, `encryption-settings`, `search`, `i18n`, `admin`) are unchanged and must remain **after** the reel scenes in the array. Verify none of them referenced the removed `rooms` scene id (they navigate independently, so they don't). No code change expected here — this is a read-through check.

- [ ] **Step 3: Type-check the whole storyboard module**

Run:

```bash
npx tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target esnext --types node \
  scripts/video/storyboard.ts scripts/video/director.ts
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/video/storyboard.ts
git commit -m "feat(video): re-author reel — live replies, file share, edit/retract, slower rhythm"
```

---

### Task 5: Render, inspect, transcode

**Files:** none (verification + artifact generation)

**Interfaces:** consumes the full pipeline; produces `video/fluux-demo-reel.mp4` and `assets/readme/fluux-demo.mp4`.

- [ ] **Step 1: Render the reel**

Run (from the worktree root; the dev server is started by the Playwright config):

```bash
npm run demo:video:reel
```

Expected: console prints `✓ reel: video/fluux-demo-reel.mp4 (<frames> frames, <seconds>s)` with **seconds between ~130 and ~150** (~2:10–2:30). ffmpeg must exit cleanly (no `frames.txt`/concat errors).

- [ ] **Step 2: Inspect the new content by extracting sample frames**

Extract a frame from each new scene and the brand cards, then open them:

```bash
mkdir -p /tmp/reel-check
ffmpeg -y -i video/fluux-demo-reel.mp4 -vf "fps=1" /tmp/reel-check/f_%03d.jpg >/dev/null 2>&1
echo "Frames written: $(ls /tmp/reel-check | wc -l)"
```

Confirm by eye (open `/tmp/reel-check/`):
- Intro & outro show the **Aurora lockup** (bubble + "Fluux" wordmark) crisp, tagline beneath — not the old icon+text.
- `replies-richtext`: a code block renders highlighted; Emma's bubble shows a **quoted reply** chip.
- `file-sharing`: an **image bubble** appears in Emma's chat.
- `edit-retract`: a message shows an **"edited"** indicator; a later message shows as **retracted/deleted** (no receipts anywhere).
- Scene changes fade through the veil rather than hard-cutting; captions are on screen and readable before each feature moves.

- [ ] **Step 3: Transcode for the README**

```bash
npm run demo:video:readme
```

Expected: writes `assets/readme/fluux-demo.mp4` with no ffmpeg error. Sanity-check duration:

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 assets/readme/fluux-demo.mp4
```

Expected: ~130–150 seconds.

- [ ] **Step 4: Repo checks**

```bash
npm run typecheck
npm run lint
```

Expected: both PASS with no new errors/warnings attributable to `scripts/video/*`.

- [ ] **Step 5: Commit the README artifact**

`video/*` is gitignored; the README-embedded `assets/readme/fluux-demo.mp4` is tracked.

```bash
git add assets/readme/fluux-demo.mp4
git commit -m "chore(video): refresh README demo reel"
```

---

## Self-Review

**1. Spec coverage:**
- Slower/readable pacing → Task 1 (read-beat, crossfade, absorb) + longer intro/outro (Task 2 Step 5). ✔
- Show features working → Task 3 helpers + Task 4 live scenes (typing/reaction, reply, attachment, edit, retract, presence). ✔
- Cinematic polish (silent-safe) → `crossfade()` veil transitions (Task 1); caption fade retained. ✔
- Coverage: replies/rich-text, file/image sharing, edit/retract → Task 4 scenes 2–4. ✔
- Lockup branding → Task 2. ✔
- Runtime ~2:10–2:30 → Task 5 Step 1 gate. ✔
- No receipts, silent, scripts-only → Global Constraints + Task 5 inspection. ✔
- Full tour keeps extras → Task 4 Step 1/Step 2 preserve full-only scenes. ✔
- Spec risk "upload-sim hook incompatible with deterministic recorder" → resolved by using `attachmentBeat` (deterministic completed-image inject) instead of the real-timer progress bar; documented in Global Constraints and Task 3. ✔
- Spec risk "edit payload shape" → resolved: `chat:message-updated { conversationId, messageId, updates: Partial<Message> }`, `updates: { body, isEdited }` / `{ isRetracted, retractedAt }`. ✔

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" — every code step shows full code. ✔

**3. Type consistency:** `roomBeat` returns `string` and its `replyTo` shape (`{ id, to, fallbackBody }`) matches both the caller in Task 4 (`replies-richtext`) and the seed pattern in `act2-fileTransfer.ts`. `attachmentBeat`/`editMessage`/`retractMessage`/`presence`/`crossfade`/`absorb`/`caption` signatures declared in Tasks 1/3 match their calls in Task 4. `setTitle(_title, sub)` keeps its two-arg signature so `setup`/`intro`/`outro` callers are unchanged. ✔
