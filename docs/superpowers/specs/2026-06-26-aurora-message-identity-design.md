# Aurora — Message identity (message list, phase 1)

- Status: Draft for review
- Date: 2026-06-26
- Scope: `apps/fluux` message rendering (1:1 + rooms). No SDK changes.
- Companion to: `2026-06-26-aurora-design-direction.md` §4.3 and `2026-06-26-aurora-screen-inventory.md` #1.

## Goal

Bring the Aurora identity to the message list — the most-viewed screen. Reconnaissance showed the structural grammar is **already in place**, so this slice is narrower than the inventory implied:

- **Sender grouping already exists and is already unified.** Both 1:1 and rooms use `shouldShowAvatar` (`components/conversation/messageGrouping.ts`): same sender + <5 min + same security/whisper context → avatar + name shown once per run. No work needed.

What's left is the *identity* layer:

1. **Aurora-tuned sender colors** — the `--fluux-sender-*` tokens are defined but **dead** (zero code references); names today use raw XEP-0392 continuous hue or the roster's precomputed contact color.
2. **Own-message luminous edge** — outgoing messages are distinguished *only* by name color today; no edge.
3. **New-messages divider** — still alarm-red (`bg-fluux-red`).

## Design

### 1. Sender colors — `auroraSenderColor(identifier, isDarkMode)`

Decision (confirmed): **continuous per-person hue, Aurora-tuned** — not a discrete palette — so everyone stays distinct in 90+ person rooms while harmonizing with the deep base.

A new pure helper in `apps/fluux/src/utils/senderColor.ts`:

```
auroraSenderColor(identifier: string, isDarkMode: boolean): string
```

- Reuses the existing `generateConsistentColorHexSync` (SDK, XEP-0392) for the **deterministic hue** from `identifier` (so colors stay stable per person, same as today), but with Aurora-tuned saturation/lightness:
  - **Dark:** `{ saturation: 75, lightness: 72 }` → luminous jewel tones. On the deep base every hue clears WCAG AA on both the resting (`--fluux-chat-bg`) and hover (`--fluux-bg-hover`) rows by construction (light text on near-black).
  - **Light:** start vibrant (`{ saturation: 65, lightness: 42 }`), then **AA-correct** by darkening until the color clears 4.5:1 on the *hover* row (the harder, slightly-darker surface) — reusing the `ensureContrastWithWhite` logic currently private in `Avatar.tsx`. Intrinsically-light hues (yellow/green) darken; blues/violets stay vibrant.
- This pattern matches the existing message-row text refinements on `main` (`--fluux-text-self`, `--fluux-text-faint`, `--fluux-text-error` are all dedicated AA-tuned values for the rows).

Wiring — replace the `senderColor` computation at all three sites so known *and* unknown senders use the tuned color (one consistent system):
- `ChatView.tsx` (~`:808`) and `RoomView.tsx` (~`:1257`): `message.isOutgoing ? 'var(--fluux-text-self)' : auroraSenderColor(identifier, isDarkMode)`.
- `roomSenderResolution.ts` `resolveSenderColor` / `resolveNickColor`: delegate to `auroraSenderColor`.

Because both views already pass `avatarFallbackColor = senderColor`, and the reply chip / `@mention` pills / occupant panel all read the same `senderColor`/`resolveSenderColor`, the tuned color **flows everywhere automatically** — the avatar, the name, the reply edge we shipped, the mention pill, and the member list all agree per person.

The roster's precomputed `contact.colorLight/colorDark` are intentionally no longer used for *names* (the app computes the tuned color). The discrete `--fluux-sender-1..6` tokens are superseded by this continuous approach → **remove them** to avoid dead tokens (and their `.light` overrides + the `tailwind.config.js` `sender-1..6` aliases).

Extract `ensureContrastWithWhite` from `Avatar.tsx` into `utils/senderColor.ts` (or a small `utils/contrastColor.ts`) and have `Avatar.tsx` import it — one shared AA-darken function, no duplication.

### 2. Own-message luminous edge

Outgoing message bodies get a subtle accent left-edge (2px `--fluux-bg-accent`) + a faint accent tint (`hsla(accent, 0.10)`), via a `.message-own-edge` class in `index.css`, applied in `MessageBubble.tsx` when `message.isOutgoing`. Stays flat/grouped (no bubble). Kept subtle so a run of your own messages doesn't read heavy. Own name keeps `--fluux-text-self`.

### 3. New-messages divider → accent

`components/conversation/NewMessageMarker.tsx`: swap `bg-fluux-red` / `text-fluux-red` for the accent (a hairline rule + accent label). One-component change.

## Render-performance

No new props and no new store subscriptions. `senderColor` and `message.isOutgoing` are *already* fields in the `MessageBubble` `arePropsEqual` memo comparison, so the row bailout is unaffected. `auroraSenderColor` is a pure function (cache by `identifier|mode` if profiling shows it hot). The `messageRowMemo.test.tsx` invariants (appending / typing must not re-render existing rows) must stay green.

## Accessibility

Sender name colors clear WCAG AA (≥4.5:1) on both the resting and hover message rows, in both modes — verified by a contrast unit test (in the spirit of `themeContrast.test.ts`). Own-edge is decorative (the name color carries identity), so it isn't contrast-bound.

## Out of scope (follow-ups)

- Density modes (comfortable/compact) — separate slice.
- Grouping — already exists, untouched.
- Bubbles — rejected (flat grouped grammar is the chosen direction).

## Testing

- `senderColor.test.ts`: determinism (same identifier → same color across calls); AA contrast of the returned color vs the chat + hover backgrounds in both modes; two different identifiers generally differ; light-mode AA-correction darkens an intrinsically-light hue.
- `MessageBubble`: the own-edge class is present iff `message.isOutgoing`.
- `NewMessageMarker`: uses the accent token, not red.
- Add a message-list **screenshot scene** (a room with several distinct senders, an own message with the edge, and the new-messages divider) for visual regression of the colors — the recurring gap where CSS values aren't unit-testable.

## Anticipated files

- Create: `apps/fluux/src/utils/senderColor.ts` (+ `.test.ts`).
- Modify: `Avatar.tsx` (export/extract `ensureContrastWithWhite`), `ChatView.tsx`, `RoomView.tsx`, `roomSenderResolution.ts`, `MessageBubble.tsx`, `NewMessageMarker.tsx`, `index.css` (`.message-own-edge`; remove dead `--fluux-sender-*`), `tailwind.config.js` (remove `sender-*` aliases), plus a screenshot scene in `scripts/screenshots.ts`.
