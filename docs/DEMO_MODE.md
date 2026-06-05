# Demo Mode

Fluux includes a demo mode that renders the full UI with realistic fake data, without requiring an XMPP server. This is useful for taking screenshots, recording screen demos, and preparing marketing materials.

## Quick Start

```bash
npm run dev
```

Then open **http://localhost:5173/demo.html**

### URL Parameters

| Parameter  | Default | Description                                                                              |
|------------|---------|------------------------------------------------------------------------------------------|
| `tutorial` | `true`  | Set to `false` to disable tutorial tooltips (useful for video recording and screenshots) |

Example: **http://localhost:5173/demo.html?tutorial=false**

## What's Included

The demo populates the UI with:

- **5 contacts** with AI-generated avatars and mixed presence states (online, away, dnd, offline)
- **3 chat conversations** with message histories featuring:
  - Emoji reactions on messages
  - Message replies (XEP-0461)
  - Image attachment (screenshot)
  - PDF attachment
  - Video attachment
  - Link preview with Open Graph metadata (XEP-0422 Message Fastening)
- **1 group chat room** ("Team Chat") with 4 occupants, reactions, and replies
- **Live animations** that start after page load: typing indicators, incoming messages, and emoji reactions

## Recording a Demo Video

A Playwright pipeline drives demo mode and records a promo-style walkthrough of the major features. It produces two variants from one shared storyboard:

| Command                   | Produces                              | Length                |
|---------------------------|---------------------------------------|-----------------------|
| `npm run demo:video`      | both variants                         | —                     |
| `npm run demo:video:reel` | `video/fluux-demo-reel.{mp4,webm}`    | ~45s highlight reel   |
| `npm run demo:video:full` | `video/fluux-demo-full.{mp4,webm}`    | ~80s full tour        |

Output is written to the git-ignored `video/` directory at the repo root, as **native 1920×1080 MP4 and WebM** (no upscaling).

### Prerequisites

```bash
npm run build:sdk                 # demo consumes the built SDK
npx playwright install chromium   # one-time, if not already installed
# ffmpeg must be on PATH — it assembles the captured frames into the MP4 + WebM
```

Playwright starts the dev server automatically (reusing one already running on `:5173`).

### How it works

The recorder is a **deterministic stepped capture** (see `scripts/video/director.ts`):

- The app renders at a dense **1280×720** viewport with **`deviceScaleFactor: 1.5`**, so it fills the frame (like the marketing screenshots) and `page.screenshot()` produces **true native 1920×1080** frames — no upscaling. (`recordVideo` / CDP screencast capture at the CSS-viewport resolution, forcing a 720p-or-upscale trade-off; `page.screenshot()` respects the device scale.)
- It takes **one screenshot per output frame.** Script-controlled motion — the synthetic gliding cursor, caption and title-card fades — advances one eased step per frame, so motion is smooth by construction and fully deterministic (no virtual-clock fragility).
- The app's own CSS transitions/animations are **frozen**, so every frame is a clean, deterministic still; static moments are a single screenshot held for a duration.
- "Live" beats (typing indicators, incoming messages, reactions) are injected through `DemoClient` and then held, rather than relying on wall-clock timers.
- ffmpeg assembles the frames (with per-frame durations) into an exact, smooth **30fps** MP4 + WebM.

Because it screenshots frame-by-frame, **rendering is slower than real time** (~1 min reel / ~2 min full) — fine for a one-off asset, and the result is reproducible.

### Editing the walkthrough

| File                          | Purpose                                                                    |
|-------------------------------|----------------------------------------------------------------------------|
| `scripts/video/storyboard.ts` | Ordered scenes — add, reorder, or retag features here                      |
| `scripts/video/director.ts`   | The stepped recorder: frame capture, cursor/caption/beat actions, assembly |
| `scripts/video/helpers.ts`    | Constants, page bootstrap, overlay (cursor / caption / title) injection    |
| `scripts/video/record.ts`     | Entry point (the `reel` and `full` tests)                                  |
| `playwright.video.config.ts`  | Dense fixture viewport, timeout, dev-server reuse                          |

Each scene is tagged `variant: 'reel'` (appears in both videos) or `variant: 'full'` (full tour only), so the reel is a strict subset of the full tour. Scenes drive the `Director` — e.g. `d.navigateTo('rooms')`, `d.selectItem('Team Chat')`, `d.caption(...)`, `d.typeBeat(...)`.

## Architecture

### Entry Point

`apps/fluux/demo.html` loads `apps/fluux/src/demo.tsx`, which:

1. Clears all persisted state (localStorage and IndexedDB) to prevent stale data
2. Builds demo data via `buildDemoData()` and `buildDemoAnimation()` from `apps/fluux/src/demo/demoData.ts`
3. Creates a `DemoClient` instance and calls `populateDemo(data)` with the built data
4. Renders the app with the demo client injected via `<XMPPProvider client={demoClient}>`
5. Starts live animations after React mounts via `startAnimation(steps)`

### DemoClient (SDK)

`packages/fluux-sdk/src/demo/DemoClient.ts` extends `XMPPClient`:

- Overrides `sendStanza()` and `sendIQ()` as no-ops (no real XMPP connection)
- `populateDemo(data: DemoData)` seeds all Zustand stores synchronously via `emitSDK()` calls
- `startAnimation(steps: DemoAnimationStep[])` schedules timed events (typing, messages, reactions) on `setTimeout`s
- Sets MAM query state to "history complete" so no loading spinners appear

The SDK also exports the `DemoData`, `DemoAnimationStep`, and related type interfaces, plus time-offset helpers (`minutesAgo`, `hoursAgo`, `daysAgo`) so any app can build its own demo data.

### Demo Data (App)

`apps/fluux/src/demo/demoData.ts` contains all Fluux-specific demo content:

- Contacts, presence events, conversations, messages, rooms, occupants, room messages, activity events
- All message IDs are stable strings (e.g., `demo-emma-1`) to prevent duplicates across reloads
- Timestamps are relative to `Date.now()` so the demo always looks fresh
- Exports `buildDemoData(): DemoData` and `buildDemoAnimation(): DemoAnimationStep[]`

### Demo Assets

`apps/fluux/public/demo/` contains:

| File                            | Description                                       |
|---------------------------------|---------------------------------------------------|
| `avatar-emma.webp`              | Contact avatar (256x256 WebP)                     |
| `avatar-james.webp`             | Contact avatar                                    |
| `avatar-sophia.webp`            | Contact avatar                                    |
| `avatar-olivia.webp`            | Contact avatar                                    |
| `avatar-mia.webp`               | Contact avatar                                    |
| `avatar-self.webp`              | Own user avatar                                   |
| `screenshot-contacts.png`       | Contacts view screenshot (Emma's conversation)    |
| `screenshot-chat-dark.png`      | Chat dark mode screenshot (Olivia's conversation) |
| `screenshot-chat-light.png`     | Chat light mode screenshot (Olivia's conversation)|
| `screenshot-code-block.png`     | Code block screenshot (James's conversation)      |
| `screenshot-poll.png`           | Poll feature screenshot (Team Chat)               |
| `fluux-sdk-api-reference.pdf`   | PDF attachment in Sophia's conversation           |
| `sdk-walkthrough.mp4`           | Video attachment in Sophia's conversation         |
| `link-preview-fluux-013.png`    | OG image for link preview in James's conversation |

## Production Build Isolation

Demo assets are **never included** in production builds:

1. **Vite build input** — `demo.html` is not listed in `rollupOptions.input`
2. **Strip plugin** — the `strip-demo` Vite plugin deletes `dist/demo/` and `dist/demo.html` after build
3. **Service worker** — `globIgnores: ['demo/**', 'demo.html']` excludes demo files from SW precache

## Adding or Modifying Demo Content

- Edit `apps/fluux/src/demo/demoData.ts` to change conversations, messages, or contacts
- Add new assets to `apps/fluux/public/demo/`
- The `DemoClient` is exported from `@fluux/sdk` so third-party apps can build their own demo data using the `DemoData` interface and time helpers
