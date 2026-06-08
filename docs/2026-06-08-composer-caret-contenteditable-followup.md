# Room composer caret drift — follow-up plan (contenteditable / Lexical)

**Status:** Deferred until **after 0.16.0 stable**. Do not implement before then.
**Created:** 2026-06-08
**Context:** Bug investigation 2026-06-08 — the room/MUC message composer's text
caret is misaligned from where characters appear, starting at the second
(wrapped) line and worsening as the composer grows. Reproduced by the
maintainer in **Brave on Android (Blink)** and **Tauri on macOS (WebKit)**.
1:1 chat is unaffected.

This document captures the root cause (so the investigation is not redone) and
the chosen fix direction, which is structural and therefore deferred out of the
0.16.0 beta.

---

## Symptom

In a room composer, as you type a message that wraps onto multiple lines, the
blinking caret drifts away from the glyph it should sit next to. Line 1 is
correct; the offset appears at the first wrap and accumulates with each
additional line ("depends on how much the composer has grown"). Cross-engine
(Blink + WebKit), so it is deterministic, not a single-engine rendering quirk.

## Root cause

The room composer is **not** a normal textarea. It stacks two elements:

- a **transparent `<textarea>`** that owns the blinking caret, and
- an `absolute inset-0` **mirror `<div>`** that renders the visible text and
  colours `@mentions`.

See `apps/fluux/src/components/RoomView.tsx` — `renderMentionInput` (~line 1788,
the overlay `<div>` + transparent `<TextArea>`) and `renderInputWithMentions`
(~line 2052, the highlighted spans). The shared classes live in
`apps/fluux/src/components/MessageComposer.tsx` (`MESSAGE_INPUT_BASE_CLASSES` /
`MESSAGE_INPUT_OVERLAY_CLASSES`, ~line 35) and the auto-resize in the same file
(~line 296). The 1:1 `ChatView` composer uses the **default** renderer — a plain
*visible* textarea with no overlay — which is why it can never drift.

A `<textarea>` and a `<div>` measure proportional text with tiny sub-pixel
differences, so **they soft-wrap at different character positions.** Measured
live at DPR 2 for one long unbroken string:

| Layer | Wrap points (char index) |
| --- | --- |
| `<textarea>` (caret) | `[26, 49]` |
| overlay `<div>` (glyphs) | `[26, 51]` |

They agree on the first wrap and diverge from the second. From that point the
caret (textarea layout) and the visible glyphs (overlay layout) are on different
lines — exactly the reported drift.

## What was ruled out

- **Line-height.** Maintainer diagnostic at DPR 3: textarea and overlay both
  report 24px per line, `driftPerLine: 0`. Not a line-height mismatch.
- **Every CSS wrapping/measurement lever.** Empirically tested on both layers:
  `word-break: break-word` (current), `word-break: break-all`,
  `overflow-wrap: anywhere`, and `text-rendering: geometricPrecision` +
  `font-kerning: none`. **All four produce the identical `[26,49]` / `[26,51]`
  divergence.** No CSS property makes a textarea and a div wrap identically.
- **The recent refactor.** The overlay has existed since the first public
  release; PRs #451 / #455 were memoization-only. "Related to recent
  refactoring" was a false lead.
- **Mention visibility is not at risk.** Sent messages highlight mentions via a
  separate path (`apps/fluux/src/components/conversation/MessageBody.tsx`,
  `renderStyledMessage`, ~line 109), independent of the composer overlay.

## Why the fix must be structural

Two separate elements will never agree on wrap points across engines/DPRs — CSS
cannot fix it (proven above). The only way to keep live in-composer mention
colouring **and** a correct caret is to render the text and the caret in **one
element**, i.e. a `contenteditable` editor where the glyphs and the caret share a
single layout. This is drift-free on every engine by construction.

---

## Chosen direction: a single-element (`contenteditable`) composer

### The risk lives on mobile

The entire reason this is deferred (rather than shipped quickly) is that
`contenteditable` is where mobile bites: IME / composition events, swipe typing,
autocorrect, and caret jumps on iOS Safari and Android Chrome/Brave. A naive
hand-rolled `contenteditable` re-encounters exactly the mobile selection bugs we
are trying to escape. So the implementation choice is itself the main decision.

### Option A — integrate **Lexical** (recommended to evaluate first)

[Lexical](https://lexical.dev) is Meta's framework-agnostic editor core with
`@lexical/react` bindings. It is the front-runner **specifically because it
solves the part that is the whole risk**: a hardened, cross-browser selection +
IME/composition model, maintained against real iOS/Android quirks.

What it gives us:

- **Plain-text-style editing** via `PlainTextPlugin` + `ContentEditable`, so we
  don't inherit rich-text behaviour we don't want.
- **Custom `MentionNode`** (a `TextNode` subclass, or a `DecoratorNode` for an
  atomic chip) for coloured, `contenteditable=false` mention tokens — which
  *replaces and simplifies* today's manual "backspace deletes the whole mention"
  logic in `renderMentionInput`.
- **Clean serialization.** We read the editor state node tree → plain text +
  `MentionReference[]` offsets, instead of parsing `contenteditable` DOM by hand.
- **Built-in placeholder, free auto-resize** (the `MessageComposer` height JS at
  ~line 296 goes away for this path), and a robust `OnChangePlugin`.
- A documented mentions/typeahead pattern (`LexicalTypeaheadMenuPlugin`),
  although we can keep our existing `useMentionAutocomplete` UI and only use
  Lexical to insert/maintain mention nodes.

Trade-off to decide explicitly in the plan: **bundle size and a new dependency
vs. the SDK's minimalism.** Lexical core + `@lexical/react` is moderate (tens of
KB gzipped). The app (not the SDK) is the consumer, so this does not touch the
`@fluux/sdk` surface — but it is still a notable addition and should be weighed.

### Option B — hand-rolled `contenteditable`

Smaller dependency footprint, but we would re-implement selection/IME handling
that Lexical already hardens. High risk of reintroducing mobile caret bugs.
Only choose this if a Lexical evaluation shows the bundle/dependency cost is
unacceptable and we accept owning the IME edge cases.

### Option C — cheap fallback (no live colour)

If contenteditable proves too costly to land well, ship the **deletion** instead
of a rewrite:

- Make the room composer a **plain visible textarea** (remove the overlay —
  identical to the 1:1 composer). Fully fixes the caret on every engine; the only
  loss is the *live* mention colour while typing (autocomplete still works,
  mentions still coloured once sent). Lowest-risk change of all.
- Or **visible textarea + overlay reduced to a subtle mention background tint**
  (caret fully fixed; the tint may sit a few px off on wrapped lines, far less
  jarring than a misaligned caret).

This fallback can ship at any time as a stopgap if the caret bug is escalated
before the contenteditable work is scheduled.

---

## Implementation outline (Option A)

1. **Spike / evaluation.** Add Lexical behind a single `RoomMessageInput` render
   path. Confirm bundle delta, mention node behaviour, and — critically — IME on
   iOS Safari + Android Brave before committing to it.
2. **MentionNode + insertion.** Implement the custom node and wire
   `useMentionAutocomplete` selection to insert it; port the atomic
   delete/caret-placement behaviour.
3. **Serialization adapter.** Editor state ⇄ `{ text, references: MentionReference[] }`
   with surrogate-pair-safe (emoji) offset mapping. Keep the send pipeline and
   XEP reference-id rules unchanged (see
   `docs`/memory note on MUC reference-id rules — corrections use origin-id).
4. **Composer parity.** Placeholder, Enter-to-send / Shift-Enter newline, paste
   sanitization (strip formatting → plain text), emoji insertion, edit-message
   prefill, draft persistence, auto-grow.
5. **Remove the dual-layer path** for rooms once parity is proven; keep 1:1
   untouched (or unify later).

### Reuse (input-agnostic, carries over unchanged)

`useMentionAutocomplete`, the `MentionReference[]` model, the XEP-0372 /
reference-id rules, the file-upload / link-preview / draft hooks, and the send
pipeline. **Only the input primitive changes.**

### Hard parts checklist

- DOM/editor-state ⇄ (plain text + reference offsets), emoji/surrogate-safe.
- Mobile IME / composition / swipe / autocorrect (the acceptance risk).
- Paste sanitization to plain text.
- Placeholder (Lexical built-in; CSS `:empty::before` if hand-rolled).
- Caret placement after autocomplete insert; atomic `contenteditable=false`
  mention chips.

### Acceptance gate — test matrix

Each cell with IME/autocorrect, paste, emoji, and a long wrapping message:

| | iOS Safari | Android Brave/Chrome | Tauri/WebKit (macOS) | Desktop Chromium/Firefox |
| --- | --- | --- | --- | --- |
| Caret tracks glyph on every wrapped line | ☐ | ☐ | ☐ | ☐ |
| Mention insert / atomic delete | ☐ | ☐ | ☐ | ☐ |
| IME / autocorrect / swipe typing | ☐ | ☐ | ☐ | ☐ |
| Paste, emoji, edit-prefill, draft restore | ☐ | ☐ | ☐ | ☐ |

The caret-tracking row is the whole point of the change and must pass on the two
engines that originally reproduced the bug (Android Blink, macOS WebKit).

## Files likely touched

- `apps/fluux/src/components/RoomView.tsx` — `renderMentionInput`,
  `renderInputWithMentions` (replaced by the Lexical path).
- `apps/fluux/src/components/MessageComposer.tsx` — the `renderInput` seam,
  shared input classes, auto-resize (removed for the contenteditable path).
- New: a `RoomComposerEditor` (Lexical) component + `MentionNode` + a
  serialization helper.
- `package.json` — `lexical`, `@lexical/react` (Option A only).
- No `@fluux/sdk` changes expected.

## Decision log

- **2026-06-08:** Investigated and root-caused (textarea/overlay wrap
  divergence; CSS cannot fix it). Decided to **defer past 0.16.0** and implement
  the single-element contenteditable editor, **evaluating Lexical first** because
  the mobile IME hardening is the entire risk. Plain-textarea fallback documented
  as a stopgap.
