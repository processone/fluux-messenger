# Virtualization-friendly bulk copy (hybrid, shared core)

Date: 2026-06-24
Status: Approved (desktop-first; touch entry is a documented fast-follow)

## 1. Problem

Message-list virtualization ships ON by default (`enableMessageVirtualization`,
`apps/fluux/src/utils/featureFlags.ts`). It was briefly defaulted OFF (#648) while scroll
integration was reworked, then re-enabled (#650) once the prepend / bottom-stick / WebKit
momentum fixes (#641, #643, #646, #659) landed, so the regression below is live again.
Virtualized rows are removed from the DOM as
they scroll out of the window. Per the DOM spec's node-remove steps, removing a node
relocates any live `Range` boundary to the parent, so the browser **collapses** a text
selection the instant it would span an unmounted row (verified on Blink, measured: a
92-char selection becomes `isCollapsed`, both boundaries on the spacer; DOM-spec, so the
same on WebKit).

Consequence: within-window multi-message copy still works (`useMessageCopyFormatter`
reconstructs it from the in-memory array via `buildCopyText`), but **copying a large
range in one drag gesture is impossible**. This is a regression from the old full-mount
behavior. See the "Verified correction" note in
`docs/superpowers/specs/2026-06-23-message-view-virtualization-design.md`
(Multi-message copy section).

## 2. Goals / Non-goals

**Goals**
- Restore bulk copy of a large message range, decoupled from DOM text selection.
- Reuse the existing pure formatter `buildCopyText` and the per-view
  `formatMessageForCopy` resolvers (1:1 in `ChatView`, rooms in `RoomView`).
- Keep the pure logic isolated and test-driven.
- Contain the change to the message list; leave `ChatView` / `RoomView` untouched.

**Non-goals (this change)**
- Touch / pointer "select" entry point (documented fast-follow, section 9).
- Non-contiguous multi-select (arbitrary checkbox toggling). The model is a contiguous
  range; a `Set`-based extension is possible later on the same core.
- Copying history that is not yet loaded. Only the in-memory array can be copied.

## 3. Design overview

A bulk-copy selection is a **contiguous range** `{ anchorId, focusId }` over the
in-memory loaded message array, held in React state. It is independent of:
- the browser's text selection (which cannot span unmounted rows), and
- the existing keyboard-navigation `selectedMessageId` (`useMessageSelection`), which is a
  single-row highlight for the action toolbar and arrow-key nav.

Two entry points populate the same range (the "hybrid"):
- **Cmd/Ctrl+A** selects the whole loaded conversation/room (`anchor = first`,
  `focus = last`).
- **Shift-click** on a message sets/extends the range (first shift-click begins at that
  message; subsequent shift-clicks move the focus).

A contiguous range is chosen over an arbitrary `Set` because both task-named gestures are
range-shaped ("a message range", "the whole loaded range"), the copied output stays
gap-free, and it is the simplest model that is still fully unit-testable.

Selected rows get a calm highlight; a floating bar shows the count and a Copy action.
Copy reconstructs text from the array (never from the DOM) via `collectRangeMeta` ->
`buildCopyText`.

## 4. Pure core: `apps/fluux/src/utils/messageRangeSelection.ts`

All logic is pure and unit-tested first (TDD). No DOM, no React.

```ts
export interface CopyRange {
  anchorId: string
  focusId: string
}

export type SelectionAction =
  | { type: 'extendTo'; id: string } // shift-click / "to here": begin if none, else move focus
  | { type: 'selectAll' }
  | { type: 'clear' }

/** Indices of the range endpoints in array order, direction-agnostic.
 *  null when either id is absent (e.g. a selected message was retracted). */
export function rangeIndices(
  orderedIds: string[],
  range: CopyRange,
): { start: number; end: number } | null

/** Inclusive slice of ids in array order (empty when the range is invalid). */
export function rangeIds(orderedIds: string[], range: CopyRange): string[]

/** Whole-list range, or null when the list is empty. */
export function selectAllRange(orderedIds: string[]): CopyRange | null

/** Drop the selection if an endpoint vanished (retraction, conversation switch). */
export function pruneRange(
  range: CopyRange | null,
  orderedIds: string[],
): CopyRange | null

/** Pure state transition. `extendTo` begins the range when state is null, otherwise
 *  keeps the anchor and moves the focus. */
export function selectionReducer(
  state: CopyRange | null,
  action: SelectionAction,
  orderedIds: string[],
): CopyRange | null

/** Slice messages to the range and map each to clipboard metadata, ready for
 *  buildCopyText. Pure given a pure formatForCopy. */
export function collectRangeMeta<T extends { id: string }>(
  messages: T[],
  range: CopyRange,
  formatForCopy: (m: T) => CopyMessageMeta,
): CopyMessageMeta[]
```

`buildCopyText` (unchanged) turns `CopyMessageMeta[]` into the date-grouped text. It
returns `null` for fewer than two bodied messages; the hook handles the single-message
case (section 5).

## 5. State hook: `apps/fluux/src/hooks/useMessageRangeSelection.ts`

A thin wrapper over the pure core. Parallels `useMessageSelection` in spirit but tracks a
range, not a single id.

Inputs: `{ messages: T[]; formatForCopy: (m: T) => CopyMessageMeta; conversationId: string }`.

Returns:
- `copySelectedIds: Set<string>` — memoized from `rangeIds(messages.map(m => m.id), range)`, for
  cheap per-row highlight (compared as a primitive `has(id)` in the row, mirroring how
  `selectedMessageId` is already compared).
- `selectionCount: number`, `isSelecting: boolean`.
- `extendTo(id)`, `selectAll()`, `clear()`.
- `copySelected(): void` — builds the text and writes it to the clipboard.

Behavior:
- `copySelected()` uses `buildCopyText(collectRangeMeta(...))`; when exactly one message is
  selected it copies that message's raw body instead (buildCopyText returns null for a
  single body). Writes via `navigator.clipboard.writeText` (a keydown/click is a valid
  user gesture), then fires a `toastStore` success: "Copied N messages".
- The range is pruned via `pruneRange` whenever `messages` changes (retraction removes an
  endpoint) and cleared when `conversationId` changes.

## 6. Wiring: contained in `apps/fluux/src/components/conversation/MessageList.tsx`

MessageList already receives `messages` (its `deduplicatedMessages`) and
`formatMessageForCopy`, so the whole feature lives here with **zero churn in ChatView /
RoomView**. The hook is consumed once, by MessageList.

**Keyboard (Cmd/Ctrl+A, Esc, Cmd/Ctrl+C):** a `window` keydown listener (the same
window-listener pattern as `useTypeToFocus` / `useKeyboardShortcuts`), guarded so it only
acts when focus is within this list's focus zone:
`scrollContainer.contains(activeElement) || scrollContainer.closest('.focus-zone')?.contains(activeElement)`.
It ignores events whose target is an input / textarea / contenteditable, so the composer's
own Cmd/Ctrl+A is unaffected.
- Cmd/Ctrl+A: `preventDefault()` (suppress native select-all), then `selectAll()`.
- Escape: `clear()`.
- Cmd/Ctrl+C: only while `isSelecting`, `preventDefault()` then `copySelected()` (the
  `preventDefault` avoids a trailing empty native copy with no DOM selection). When not
  selecting, native copy and the existing `useMessageCopyFormatter` path are untouched.

`mod+A` is currently unbound in `useKeyboardShortcuts`, so there is no global conflict.

**Shift-click (range):** a delegated listener on the scroll container reads `e.shiftKey`
and `target.closest('[data-message-id]')`. On a shift-click inside a row it
`preventDefault()`s (suppressing the browser's shift text-extend) and calls
`extendTo(id)`. A plain (non-shift) mousedown inside the list clears any active range, so
a normal drag resumes native text selection.

**Row highlight:** MessageList adds a `copy-selected` class to its `.message-row` div when
`copySelectedIds.has(msg.id)`, on **both** the virtualized and legacy render paths. The
bubbles are not touched.

**Selection bar:** `MessageSelectionBar` (new component, section 7) is rendered next to the
existing scroll-to-bottom FAB, shown when `selectionCount > 0`.

**No conflict with existing copy paths:** a range selection means the DOM text selection is
collapsed, so `useMessageCopyFormatter` and the legacy `useMessageCopy` early-return as
they do today.

## 7. UI, styling, i18n, feedback

**`MessageSelectionBar.tsx`** (new, in `components/conversation/`): a small floating bar
shown when a selection is active. Content: "N selected", a Copy button, and a Done button
(clears the selection). Positioned like the scroll-to-bottom FAB; does not obstruct the
composer.

**Row highlight CSS** in `apps/fluux/src/index.css` (alongside the existing
`.composer-active` rules): `.message-row.copy-selected` gets its background from the Aurora
selection token `--fluux-selection-bg` (accent-derived, already tuned per theme for light
and dark). Using the token rather than a hardcoded color keeps the highlight correct across
Aurora's themes and accent presets, and reads as "selected" consistently with native text
selection. Calm by default, not alarming.

**i18n** (real translations in all 33 locales; the `i18n.test.ts` parity test enforces key
presence):
- `chat.selection.count` -> "{{count}} selected"
- `chat.selection.copy` -> "Copy"
- `chat.selection.done` -> "Done"
- `chat.selection.copied` -> "Copied {{count}} messages"

**Feedback:** `toastStore` success toast on copy.

No em-dashes or en-dashes in any user-facing string (UI/i18n).

## 8. Interaction edge cases

- **Conversation/room switch:** selection cleared (keyed on `conversationId`).
- **Retraction / message removed:** `pruneRange` drops the selection when an endpoint id
  is gone (keeps it gap-free and valid).
- **New messages arrive mid-selection:** ids are stable, so the range stays valid; new
  messages outside the range are not included.
- **Plain drag while a range is active:** clears the range, native text selection resumes.
- **Single message selected:** Copy copies that message's raw body (buildCopyText needs two
  bodies).
- **Composer focused:** Cmd/Ctrl+A is ignored by the list (guard excludes inputs), so it
  selects composer text as usual.
- **Empty / one-message list:** Cmd/Ctrl+A on an empty list is a no-op; on one message it
  selects that message.

## 9. Scope and fast-follow

**This change (desktop hybrid):** Cmd/Ctrl+A + Shift-click + Esc + Cmd/Ctrl+C, the row
highlight, the selection bar, the copy path, and the pure core with its tests.

**Fast-follow (touch / discoverable entry), same core, no rework:** a "Select" action in
the per-message action menu (the bubble's existing long-press menu) that calls
`extendTo(id)` to begin a selection, after which taps extend the range. Touch is scoped out
of this change because that entry lives in the per-bubble long-press surface
(`MessageBubble`), which is a separate, larger component surface than the contained
list-level work here; long-press is already claimed by the action menu, so it must be a
menu item rather than a new gesture.

## 10. Testing (TDD)

Pure core (`apps/fluux/src/utils/messageRangeSelection.test.ts`) drives the work:
- `rangeIndices`: both directions (anchor before/after focus), equal anchor/focus, missing
  id -> null.
- `rangeIds`: inclusive, array order, invalid range -> empty.
- `selectAllRange`: empty -> null, single, many.
- `pruneRange`: endpoint present -> unchanged, endpoint vanished -> null.
- `selectionReducer`: `extendTo` begins when null and moves focus when set; `selectAll`;
  `clear`.
- `collectRangeMeta` -> `buildCopyText`: a known range produces the expected date-grouped
  text via a stub `formatForCopy`.

Hook / wiring gets a lighter integration test: selection state transitions and the copied
clipboard payload (mock `navigator.clipboard` + `toastStore`).

## 11. Files

**New**
- `apps/fluux/src/utils/messageRangeSelection.ts` + `.test.ts`
- `apps/fluux/src/hooks/useMessageRangeSelection.ts` (+ light test)
- `apps/fluux/src/components/conversation/MessageSelectionBar.tsx`

**Modified**
- `apps/fluux/src/components/conversation/MessageList.tsx` (consume hook; window keydown
  guard; delegated shift-click; row `copy-selected` class on both paths; render bar)
- `apps/fluux/src/index.css` (`.message-row.copy-selected`)
- `apps/fluux/src/hooks/index.ts` (export the new hook)
- i18n locale files (4 new keys x 33 locales)
