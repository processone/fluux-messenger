# Send button: press + glow pulse animation

**Date:** 2026-07-15
**Status:** Design — awaiting review
**Origin:** User suggestion (community member "stepforward") requesting a "pushing animation" on the 3D send button — a pressed/unpressed feel where sending pushes the button back down to its inactive grey state.

## Problem

The composer's send button already transitions between two states:

- **Empty input** → `:disabled`, muted "grey default" look (index.css `.send-aurora:disabled`).
- **Text typed / attachment pending** → enabled "liquid glass" aurora look with a pseudo-3D inset top highlight and (non-Linux) a blurred aurora glow behind it.

What is missing is *motion on the send action itself*. The button carries only `transition-colors`; there is no press, no depress, no "sent!" feedback. The grey↔active swap is a color fade, not a physical gesture. The user noticed exactly this gap: the button "wakes up" on the first character but does not visibly "get pushed" when you send.

## Goal

Add a tactile send gesture that leans into the existing aurora identity — a press + glow pulse — that fires on **every** send the button performs (text, attachment, or slash-command), then relaxes back to the disabled grey state as the input clears. No rebuild of the state logic; the grey↔active behavior already exists and stays as-is.

## The gesture (three beats)

1. **Press down** (~90ms) — the button scales to ~0.92 and its inset top highlight deepens (shadow shifts inward), reading as physically pushed in.
2. **Glow bloom** (~180ms, simultaneous) — the existing `.send-aurora-glow` span briefly scales up and brightens (opacity + scale pulse), like the aurora flaring as the message launches.
3. **Release to grey** — because the send clears the input, the button naturally falls back to `:disabled`/muted. The glow fades out as part of that transition. The loop lands back at "asleep grey," matching the user's mental model.

## Technical decisions

### Trigger via a short-lived JS class, not `:active`

Most sends happen via the **Enter key**, not a pointer click. `:active` only fires on pointer press and would miss the primary send path — and beat 2 (the glow pulse) cannot be expressed by `:active` at all. Therefore:

- On the actual send action, add a short-lived class (e.g. `send-launch`) to the button.
- Remove it on `animationend` (or via a timeout fallback) so repeated sends re-trigger cleanly.
- A plain `:active` scale MAY remain *additionally* purely for click-feel, but the `send-launch` class is the source of truth for the full gesture.

### Fire on any send

The class is toggled in the send handler, so it fires for text, attachment, and command sends alike — the button always confirms the action it just performed. No branching on input classification.

### Respect `prefers-reduced-motion`

Under reduced motion, drop the scale and the pulse entirely; keep only the existing color transition. Users who opted out of motion see the current behavior.

### Linux / WebKitGTK fallback

The `.send-aurora-glow` span does not render on Linux (glass is flattened to a solid gradient via `data-platform`, per the WebKitGTK backdrop-filter limitation). There is no glow to pulse there, so:

- The press-scale (beat 1) still applies.
- Beat 2 falls back to a brief brightness + scale flash on the solid button itself, so the gesture does not feel dead on that platform.

## Scope / files

- **`apps/fluux/src/index.css`** — new `@keyframes` for the launch gesture; a `.send-launch` (and glow-pulse) rule; a `prefers-reduced-motion` branch that neutralizes it; a Linux/`data-platform` fallback branch. Reuses existing `.send-aurora` / `.send-aurora-glow` selectors.
- **`apps/fluux/src/components/MessageComposer.tsx`** — a few lines to add `send-launch` to the button on send and clear it on `animationend`. No changes to the grey↔active disabled logic (lines ~1032/1037), no new state machine.

No new dependencies. No SDK changes.

## Verification

- Demo mode (`npm run dev` → `/demo.html`) to feel the gesture on click and on Enter, for text / attachment / command sends.
- Confirm reduced-motion neutralizes it (emulate `prefers-reduced-motion`).
- Confirm the Linux fallback path renders a flash rather than a dead press (simulate via `data-platform`).

## Out of scope (YAGNI)

- No icon "launch/fly-away" animation on the paper plane (that was an alternative direction, not chosen).
- No changes to the empty/active color states themselves.
- No sound / haptics.
