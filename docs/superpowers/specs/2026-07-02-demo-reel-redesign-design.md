# Demo Reel Redesign — Slower, Richer, More Cinematic

**Date:** 2026-07-02
**Status:** Approved design, ready for implementation plan
**Scope:** The **reel** variant of the demo video (`npm run demo:video:reel`) — the ~90s clip embedded in the README. The **full** tour inherits the new feature scenes but keeps its extra sections.

## Problem

The current reel feels rushed. Two root causes:

1. **Pacing — captions and actions collide.** A caption fades in over ~0.3s, then the feature action fires almost immediately. The viewer must read a two-line caption *and* watch the feature at once, and the dwell afterward is often shorter (1.2–2s) than the time it takes to read the caption alone. Scene cuts are instant (CSS transitions are frozen for determinism), so there is no settle beat between scenes.
2. **Shallowness — features are labeled, not shown.** Most scenes are `navigate → caption → dwell → clear`: a still frame with a text label. The richness of the app is *stated*, not *felt*.

The video should feel calm, readable, and rich enough that a first-time viewer grasps how full-featured Fluux is.

## Goals

- Slower, readable pacing: caption is read *before* the feature moves; every scene ends on an absorb-hold.
- Show features working as live interactions (typing → message, upload progress → image, in-place edit, retraction, presence changes, reactions).
- Cinematic polish that survives silent playback (README/social autoplay muted): gentle cross-fade transitions between scenes, animated caption reveals.
- Broader coverage: add **replies & rich text/markdown**, **file & image sharing**, and **edit & retraction** scenes.
- Brand the intro/outro with the current Aurora **logo lockup**.

Runtime target: **~2:10–2:30** (approved growth from ~90s). Still short enough for a README embed.

**Non-goals:** No audio/music (ship silent, as today — `-an`). No **read receipts** (not implemented in the product; must not be shown or claimed). No change to the deterministic recorder architecture (Director + ffmpeg). No new demo product features — everything is driven with existing demo capabilities.

## Approach

Keep the deterministic stepped recorder (`scripts/video/director.ts` → one native-resolution frame per step → ffmpeg concat at 30fps). Fix the root causes with a small set of reusable Director primitives, then re-author `scripts/video/storyboard.ts`.

Rejected alternatives:
- **Minimal dwell-bump** (only lengthen holds): delivers none of "show working," "cinematic," or "more coverage." Half a fix.
- **Reuse the 6-act live timeline (`src/demo/animation/act1..act6`) as the reel spine**: those acts run 4+ minutes of virtual time and are authored for the in-app tutorial, not frame-precise reel pacing. Fights the stepped model. Rejected.

## Components

### 1. Director primitives (`scripts/video/director.ts`)

Three additions target the root causes. All reuse the existing frame-stepping (`steps`/`snap`/`hold`) and `fire()` state-injection — no new fragility, still fully deterministic.

- **Read-beat caption.** After `caption()` fades the lower-third in, it holds for a `READ_BEAT` (~1700ms) *before returning*, so the scene's feature action fires only after the viewer has had time to read. Callers no longer need to remember to `dwell()` before acting. (Existing `caption()` fade-in animation is retained; the read-beat is appended.)
- **`crossfade(fn)` scene transition.** A new full-screen dark veil layer (`#vid-veil`) dips to ~0.5 opacity over ~5 frames, the passed navigation/selection `fn` runs while covered, then the veil lifts over ~6 frames. Gives an eye-settle beat and hides the abrupt cut. Silent-friendly cinematic lever. Total ~0.4–0.5s.
- **Absorb-hold constant.** An `ABSORB` constant (~1800ms) that scenes hold on the final result before `clearCaption()`. Applied consistently so every scene lands.

Constants (`READ_BEAT`, `ABSORB`, veil frame counts) live at the top of `director.ts` (or `helpers.ts`) so pacing is tunable in one place.

### 2. Branding — inlined lockup (`scripts/video/helpers.ts`)

`installPolishLayers()` currently builds the `#vid-title` card as `<img src="/logo.png">` + a large text title (`.tt`) + subtitle (`.ts`).

Change:
- **Inline the Aurora lockup SVG** (`assets/readme/fluux-logo.svg` — Aurora bubble + "Fluux" wordmark, self-contained outlined vector paths, no font/network dependency) as the hero visual, replacing both the `<img>` and the `.tt` text title.
- Keep the subtitle slot (`.ts`) below the lockup for the tagline. `setTitle()` continues to drive it: intro → "A modern XMPP client"; outro → "Open. Secure. Yours." The `.tt` title slot is dropped (the wordmark now carries the name).
- Source the SVG markup from `assets/readme/fluux-logo.svg` at record time (read the file and inject its markup) so the card stays in sync with the canonical brand asset — no hand-copied drift.

Layout: lockup centered, tagline beneath, on the existing radial-gradient background. Size the lockup so the wordmark reads clearly at 1080p (roughly ~360–420px wide; final value tuned against a captured frame).

### 3. Storyboard (`scripts/video/storyboard.ts`)

Re-authored scene list. Every scene follows one rhythm:

> **crossfade in → caption + read-beat → live interaction → absorb-hold → caption out.**

| # | Scene id | Variant | Live motion (bold) | Feature shown |
|---|----------|---------|--------------------|---------------|
| 1 | intro | (record.ts) | Lockup card, held longer, fades to app | Brand |
| 2 | messaging | reel | Open Emma → **typing indicator → incoming message → you react 👍** | 1:1 messaging, typing, reactions |
| 3 | replies-richtext | reel | **James posts a markdown code block → Emma quote-replies it** | Replies, markdown/code |
| 4 | file-sharing | reel | **Upload progress bar fills → image appears inline**; glance at PDF / voice-note attachments | File & image sharing |
| 5 | edit-retract | reel | **Incoming msg → edits in place ("edited") → a second message retracts ("deleted")** | Edit, retraction |
| 6 | command-palette | reel | ⌘K → type "design" → **glide-click result jumps into the Design Review room** | Command palette / navigation |
| 7 | rooms-presence | reel | Team Chat → open members panel → **Sophia comes online → posts a live message** | MUC rooms, presence, roles, members |
| 8 | encryption | reel | Open Ava Martinez → lock badges (verified / TOFU), long read-beat | End-to-end encryption |
| 9 | themes | reel | Cycle light → nord → dracula → fluux → dark | Theming, light/dark |
| 10 | outro | (record.ts) | Lockup card, "Open. Secure. Yours.", held longer | Brand |

Scenes 3, 4, 5 are marked `reel`, so they also enrich the **full** tour. The full variant keeps its existing extra scenes (poll-code, whisper, encryption-settings, search, i18n, admin) appended after the shared reel scenes, per the existing `scenesFor()` variant filter.

Ordering rationale: lead with everyday messaging richness (2–5), then power/navigation (6–7), then the trust and personalization payoff (8–9), bookended by brand.

### Driving each new scene (all verified feasible in demo mode)

- **Replies & rich text (scene 3):** drive via `room:message` with a markdown code-block body, then a second `room:message` carrying `replyTo: { id, to, fallbackBody }` (same shape as `src/demo/animation/act2-fileTransfer.ts`). Alternatively scroll to seeded rich content (`james.ts` code-block + link preview). Live injection preferred for "show working."
- **File & image sharing (scene 4):** preferred — fire the live upload simulation (`demo:custom` `{ type: 'upload-start', conversationId, file }`) which drives an animated progress bar then emits an outgoing `chat:message` with an image `attachment` (`useDemoUploadSimulation.ts`). **Risk:** that hook mounts inside `DemoTutorialProvider`; the recorder runs `?tutorial=false`, which may not mount it. *Fallback:* scroll to an already-seeded inline image (`emma.ts` image attachment) and a PDF/voice-note (`sophia.ts` / `liam.ts`) — guaranteed regardless.
- **Edit & retraction (scene 5):** inject a `chat:message`, then a `chat:message-updated` with edit `updates` (body + `editedAt`) to show the "edited" tag; then a retraction. **Risk:** exact `chat:message-updated` `updates` shape for the 1:1 "edited" tag. *Fallback:* the proven room-moderation retraction from `act5-richFeatures.ts` (`room:message-updated` with `isRetracted`/`isModerated`), shown in a room instead of 1:1.
- **Presence (scene 7):** `presence` action (`roster:presence`) brings Sophia online (as in `act2-fileTransfer.ts`); members panel via the existing `Show members` button locator.

## Data Flow

Unchanged from today: `record.ts` boots the demo off-camera behind the (opaque) title card, installs polish layers, then runs `scenesFor(variant)` in order; each scene drives the `Director`, which injects demo state via `page.evaluate` → `__demoClient.startAnimation(steps)` and captures one screenshot per frame; `Director.finish()` concatenates frames with per-frame durations through ffmpeg into `video/fluux-demo-reel.mp4` (+ best-effort webm). `npm run demo:video:readme` transcodes the reel to `assets/readme/fluux-demo.mp4`.

The new primitives slot into this flow without changing it: `crossfade`/read-beat/absorb are all sequences of the existing `snap`/`hold`/`steps` calls; the lockup is a one-time markup swap in `installPolishLayers`.

## Error Handling / Robustness

- **Determinism preserved.** No wall-clock or randomness introduced; all motion is frame-stepped and all state is injected synchronously via the existing `fire()` path.
- **Locator resilience.** New scenes reuse the existing tolerant patterns (`isVisible().catch(() => false)` guards, `.first()`, hash-nav as authoritative fallback) so a missing optional element (e.g., members button) degrades to a still rather than throwing.
- **Feature fallbacks.** The two risk items (upload-sim hook, edit payload) each have a guaranteed fallback that keeps the scene on-message.
- **Asset integrity.** The lockup SVG is read from disk at record time; if the file is missing the record run fails fast (loud) rather than shipping a blank card.

## Testing / Verification

No unit test suite covers video output (it is a rendered artifact). Verification is a recorded run plus inspection:

1. `npm run build:sdk` (if any SDK types touched — not expected) then `npm run demo:video:reel`.
2. Confirm reported duration lands ~2:10–2:30 and frames assemble without ffmpeg errors.
3. Spot-check frames: the three new scenes (replies/rich-text, file-sharing, edit/retract) read clearly; the intro/outro show the **lockup** crisply; captions appear before their feature moves; transitions settle rather than snap.
4. `npm run demo:video:readme` transcode succeeds; embedded README video plays.
5. `npm run typecheck` and lint pass (the storyboard/director stay type-safe).

## Files Touched

- `scripts/video/director.ts` — read-beat in `caption()`, `crossfade()`, absorb constant.
- `scripts/video/helpers.ts` — inline lockup SVG in `installPolishLayers()`; `#vid-veil` layer styles; pacing constants (or co-located in director).
- `scripts/video/storyboard.ts` — re-authored scene list (new scenes 3–5, reordered, consistent rhythm).
- `scripts/video/record.ts` — longer intro/outro holds; wire the lockup subtitle-only title card.
- Possibly `docs`/README note if the reel runtime is documented anywhere.
