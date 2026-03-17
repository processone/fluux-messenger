# Demo Mode

Fluux includes a demo mode that renders the full UI with realistic fake data, without requiring an XMPP server. This is useful for taking screenshots, recording screen demos, and preparing marketing materials.

## Quick Start

```bash
npm run dev
```

Then open **http://localhost:5173/demo.html**

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

## Architecture

### Entry Point

`apps/fluux/demo.html` loads `apps/fluux/src/demo.tsx`, which:

1. Clears all persisted state (localStorage and IndexedDB) to prevent stale data
2. Creates a `DemoClient` instance and calls `populateDemo()`
3. Renders the app with the demo client injected via `<XMPPProvider client={demoClient}>`
4. Starts live animations after React mounts

### DemoClient

`packages/fluux-sdk/src/demo/DemoClient.ts` extends `XMPPClient`:

- Overrides `sendStanza()` and `sendIQ()` as no-ops (no real XMPP connection)
- `populateDemo()` seeds all Zustand stores synchronously via `emitSDK()` calls
- `startAnimation()` schedules timed events (typing, messages, reactions) on `setTimeout`s
- Sets MAM query state to "history complete" so no loading spinners appear

### Demo Data

`packages/fluux-sdk/src/demo/demoData.ts` contains all typed demo content:

- Contacts, presence events, conversations, messages, room, occupants, room messages
- All message IDs are stable strings (e.g., `demo-emma-1`) to prevent duplicates across reloads
- Timestamps are relative to `Date.now()` so the demo always looks fresh

### Demo Assets

`apps/fluux/public/demo/` contains:

| File | Description |
|------|-------------|
| `avatar-emma.webp` | Contact avatar (256x256 WebP) |
| `avatar-james.webp` | Contact avatar |
| `avatar-sophia.webp` | Contact avatar |
| `avatar-oliver.webp` | Contact avatar |
| `avatar-mia.webp` | Contact avatar |
| `avatar-self.webp` | Own user avatar |
| `screenshot-fluux-contacts.png` | Image attachment in Emma's conversation |
| `fluux-sdk-api-reference.pdf` | PDF attachment in Sophia's conversation |
| `sdk-walkthrough.mp4` | Video attachment in Sophia's conversation |
| `link-preview-fluux-013.png` | OG image for link preview in James's conversation |

## Production Build Isolation

Demo assets are **never included** in production builds:

1. **Vite build input** — `demo.html` is not listed in `rollupOptions.input`
2. **Strip plugin** — the `strip-demo` Vite plugin deletes `dist/demo/` and `dist/demo.html` after build
3. **Service worker** — `globIgnores: ['demo/**', 'demo.html']` excludes demo files from SW precache

## Adding or Modifying Demo Content

- Edit `packages/fluux-sdk/src/demo/demoData.ts` to change conversations, messages, or contacts
- Add new assets to `apps/fluux/public/demo/`
- The `DemoClient` is exported from `@fluux/sdk` so third-party apps can also use it
