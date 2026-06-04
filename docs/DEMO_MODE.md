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

| Command                   | Produces                              | Length                 |
|---------------------------|---------------------------------------|------------------------|
| `npm run demo:video`      | both variants                         | —                      |
| `npm run demo:video:reel` | `video/fluux-demo-reel.{webm,mp4}`    | ~90s highlight reel    |
| `npm run demo:video:full` | `video/fluux-demo-full.{webm,mp4}`    | ~3–4 min full tour     |

Output is written to the git-ignored `video/` directory at the repo root, as **1920×1080 WebM and MP4**.

### Prerequisites

```bash
npm run build:sdk                 # demo consumes the built SDK
npx playwright install chromium   # one-time, if not already installed
# ffmpeg must be on PATH for the MP4 conversion (the WebM is always produced)
```

Playwright starts the dev server automatically (reusing one already running on `:5173`).

### How it works

The script opens `/demo.html?tutorial=false`, drives navigation deterministically (via the `HashRouter`), and layers on promo polish: a synthetic gliding cursor with click ripples, lower-third captions, and intro/outro title cards. "Live" moments — typing indicators, incoming messages, reactions — are fired on cue through `DemoClient.startAnimation()` while the camera is framed on the relevant conversation.

### Editing the walkthrough

| File                          | Purpose                                                                  |
|-------------------------------|--------------------------------------------------------------------------|
| `scripts/video/storyboard.ts` | Ordered scenes — add, reorder, or retag features here                    |
| `scripts/video/helpers.ts`    | Cursor, captions, title cards, navigation, live beats, MP4 conversion    |
| `scripts/video/record.ts`     | Entry point (the `reel` and `full` tests)                                |
| `playwright.video.config.ts`  | 1080p canvas, video recording, timeout, dev-server reuse                 |

Each scene is tagged `variant: 'reel'` (appears in both videos) or `variant: 'full'` (full tour only), so the reel is a strict subset of the full tour.

> **Capture quality:** video is captured with Playwright's built-in `recordVideo` (variable frame rate) and re-encoded to a constant-30fps H.264 MP4 via ffmpeg. If motion looks choppy, the capture layer in `helpers.ts` can be swapped for deterministic frame capture (CDP screencast or interval screenshots) assembled by ffmpeg at a constant frame rate — without touching the storyboard.

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
