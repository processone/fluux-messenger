# Virtualization-friendly Bulk Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore bulk copy of a large message range under virtualization, decoupled from DOM text selection, via Cmd/Ctrl+A (select all loaded) and Shift-click (range), copied through the existing `buildCopyText` + `formatMessageForCopy`.

**Architecture:** A contiguous "copy range" `{ anchorId, focusId }` over the in-memory message array, held in a hook (`useMessageRangeSelection`) built on a pure core (`messageRangeSelection.ts`). The hook owns the imperative listeners (window keydown for Cmd/Ctrl+A, Esc, Cmd/Ctrl+C; delegated `mousedown` on the scroll container for Shift-click range and plain-click clear) and the clipboard write. `MessageList` consumes the hook to highlight selected rows (a `copy-selected` class on the `.message-row` div, both render paths) and render a floating `MessageSelectionBar`. `ChatView` / `RoomView` are untouched.

**Tech Stack:** React 18, TypeScript, Zustand (`toastStore`), react-i18next, Vitest (happy-dom for hooks/components, `@vitest-environment node` for pure utils), Tailwind, Aurora CSS tokens.

## Global Constraints

- Reuse `buildCopyText` (`apps/fluux/src/utils/buildCopyText.ts`) and the per-view `formatMessageForCopy` resolvers. Do not invent a new formatter.
- Copy only from the in-memory loaded array (`deduplicatedMessages`). Never copy unloaded history.
- The feature is contained in `MessageList` + the new hook/util/component. Do NOT modify `ChatView` or `RoomView`.
- No em-dashes or en-dashes in any user-facing string (UI / i18n).
- Row highlight uses the Aurora token `var(--fluux-selection-bg)`, never a hardcoded color.
- i18n: every English key MUST exist, non-empty, in all 33 locales (`apps/fluux/src/i18n/i18n.test.ts` parity gate). Locale files use 4-space indentation.
- The `count` label interpolates `{{num}}` (NOT `{{count}}`) so i18next pluralization is not triggered and a single key per locale suffices.
- Desktop-first. Touch / pointer "Select" entry is explicitly out of scope (documented fast-follow in the spec).
- TDD the pure core. Run tests (no stderr), `typecheck`, and lint green before each commit (per `.claude/CLAUDE.md`).
- Work on the current worktree branch `claude/charming-merkle-58f442`; squash-merge later via PR.
- App tests run from `apps/fluux` via `npx vitest run <path>`.

## File Structure

**New**
- `apps/fluux/src/utils/messageRangeSelection.ts` — pure range core (no DOM, no React).
- `apps/fluux/src/utils/messageRangeSelection.test.ts` — pure core tests (node env).
- `apps/fluux/src/hooks/useMessageRangeSelection.ts` — selection state + imperative listeners + clipboard.
- `apps/fluux/src/hooks/useMessageRangeSelection.test.tsx` — hook tests (happy-dom).
- `apps/fluux/src/components/conversation/MessageSelectionBar.tsx` — floating count + Copy + Done bar.
- `apps/fluux/src/components/conversation/MessageSelectionBar.test.tsx` — bar render/interaction test.

**Modified**
- `apps/fluux/src/i18n/locales/*.json` (33 files) — add `chat.selection.{count,copy,done,copied}`.
- `apps/fluux/src/hooks/index.ts` — export the new hook.
- `apps/fluux/src/components/conversation/MessageList.tsx` — consume hook, row class on both paths, render bar.
- `apps/fluux/src/index.css` — `.message-row.copy-selected` rule.

---

## Task 1: Pure range-selection core

**Files:**
- Create: `apps/fluux/src/utils/messageRangeSelection.ts`
- Test: `apps/fluux/src/utils/messageRangeSelection.test.ts`

**Interfaces:**
- Consumes: `CopyMessageMeta` from `apps/fluux/src/utils/buildCopyText.ts`.
- Produces:
  - `interface CopyRange { anchorId: string; focusId: string }`
  - `type SelectionAction = { type: 'extendTo'; id: string } | { type: 'selectAll' } | { type: 'clear' }`
  - `rangeIndices(orderedIds: string[], range: CopyRange): { start: number; end: number } | null`
  - `rangeIds(orderedIds: string[], range: CopyRange): string[]`
  - `selectAllRange(orderedIds: string[]): CopyRange | null`
  - `pruneRange(range: CopyRange | null, orderedIds: string[]): CopyRange | null`
  - `selectionReducer(state: CopyRange | null, action: SelectionAction, orderedIds: string[]): CopyRange | null`
  - `collectRangeMeta<T extends { id: string }>(messages: T[], range: CopyRange, formatForCopy: (m: T) => CopyMessageMeta): CopyMessageMeta[]`

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/utils/messageRangeSelection.test.ts`:

```ts
/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import {
  rangeIndices,
  rangeIds,
  selectAllRange,
  pruneRange,
  selectionReducer,
  collectRangeMeta,
  type CopyRange,
} from './messageRangeSelection'

const IDS = ['a', 'b', 'c', 'd']

describe('rangeIndices', () => {
  it('returns min/max regardless of anchor/focus direction', () => {
    expect(rangeIndices(IDS, { anchorId: 'b', focusId: 'd' })).toEqual({ start: 1, end: 3 })
    expect(rangeIndices(IDS, { anchorId: 'd', focusId: 'b' })).toEqual({ start: 1, end: 3 })
  })
  it('handles anchor === focus (single)', () => {
    expect(rangeIndices(IDS, { anchorId: 'c', focusId: 'c' })).toEqual({ start: 2, end: 2 })
  })
  it('returns null when an endpoint is missing', () => {
    expect(rangeIndices(IDS, { anchorId: 'b', focusId: 'z' })).toBeNull()
    expect(rangeIndices(IDS, { anchorId: 'z', focusId: 'b' })).toBeNull()
  })
})

describe('rangeIds', () => {
  it('returns the inclusive slice in array order', () => {
    expect(rangeIds(IDS, { anchorId: 'd', focusId: 'b' })).toEqual(['b', 'c', 'd'])
  })
  it('returns empty for an invalid range', () => {
    expect(rangeIds(IDS, { anchorId: 'b', focusId: 'z' })).toEqual([])
  })
})

describe('selectAllRange', () => {
  it('returns first..last', () => {
    expect(selectAllRange(IDS)).toEqual({ anchorId: 'a', focusId: 'd' })
  })
  it('returns a single-id range for one message', () => {
    expect(selectAllRange(['x'])).toEqual({ anchorId: 'x', focusId: 'x' })
  })
  it('returns null for an empty list', () => {
    expect(selectAllRange([])).toBeNull()
  })
})

describe('pruneRange', () => {
  it('keeps a valid range', () => {
    const r: CopyRange = { anchorId: 'a', focusId: 'c' }
    expect(pruneRange(r, IDS)).toBe(r)
  })
  it('drops the range when an endpoint vanished', () => {
    expect(pruneRange({ anchorId: 'a', focusId: 'gone' }, IDS)).toBeNull()
  })
  it('passes null through', () => {
    expect(pruneRange(null, IDS)).toBeNull()
  })
})

describe('selectionReducer', () => {
  it('extendTo begins the range when state is null', () => {
    expect(selectionReducer(null, { type: 'extendTo', id: 'b' }, IDS)).toEqual({ anchorId: 'b', focusId: 'b' })
  })
  it('extendTo keeps the anchor and moves the focus', () => {
    expect(
      selectionReducer({ anchorId: 'b', focusId: 'b' }, { type: 'extendTo', id: 'd' }, IDS),
    ).toEqual({ anchorId: 'b', focusId: 'd' })
  })
  it('extendTo ignores an unknown id', () => {
    const s: CopyRange = { anchorId: 'a', focusId: 'b' }
    expect(selectionReducer(s, { type: 'extendTo', id: 'zzz' }, IDS)).toBe(s)
  })
  it('selectAll selects the whole list', () => {
    expect(selectionReducer(null, { type: 'selectAll' }, IDS)).toEqual({ anchorId: 'a', focusId: 'd' })
  })
  it('clear resets to null', () => {
    expect(selectionReducer({ anchorId: 'a', focusId: 'd' }, { type: 'clear' }, IDS)).toBeNull()
  })
})

describe('collectRangeMeta', () => {
  const messages = [
    { id: 'a', from: 'Alice', time: '10:00', body: 'one', date: '2024-01-15' },
    { id: 'b', from: 'Bob', time: '10:01', body: 'two', date: '2024-01-15' },
    { id: 'c', from: 'Alice', time: '10:02', body: 'three', date: '2024-01-15' },
  ]
  const fmt = (m: (typeof messages)[number]) => ({
    id: m.id,
    from: m.from,
    time: m.time,
    body: m.body,
    date: m.date,
  })

  it('slices the range and maps each message via formatForCopy', () => {
    expect(collectRangeMeta(messages, { anchorId: 'a', focusId: 'b' }, fmt)).toEqual([
      { id: 'a', from: 'Alice', time: '10:00', body: 'one', date: '2024-01-15' },
      { id: 'b', from: 'Bob', time: '10:01', body: 'two', date: '2024-01-15' },
    ])
  })
  it('returns empty for an invalid range', () => {
    expect(collectRangeMeta(messages, { anchorId: 'a', focusId: 'gone' }, fmt)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/utils/messageRangeSelection.test.ts`
Expected: FAIL — `Failed to resolve import "./messageRangeSelection"` / functions not defined.

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/utils/messageRangeSelection.ts`:

```ts
/**
 * messageRangeSelection — pure core for virtualization-friendly bulk copy.
 *
 * A "copy range" is a contiguous span over the in-memory message array, identified by an
 * anchor id and a focus id. It is decoupled from the browser's text selection (which cannot
 * span virtualized/unmounted rows). All functions here are pure (no DOM, no React) so the
 * range logic is unit-tested in isolation; the hook layers state + listeners + clipboard on
 * top, and buildCopyText turns the collected metadata into text.
 */
import type { CopyMessageMeta } from './buildCopyText'

export interface CopyRange {
  anchorId: string
  focusId: string
}

export type SelectionAction =
  | { type: 'extendTo'; id: string }
  | { type: 'selectAll' }
  | { type: 'clear' }

/** Indices of the range endpoints in array order, direction-agnostic. null when either id
 *  is absent (e.g. a selected message was retracted). */
export function rangeIndices(
  orderedIds: string[],
  range: CopyRange,
): { start: number; end: number } | null {
  const a = orderedIds.indexOf(range.anchorId)
  const f = orderedIds.indexOf(range.focusId)
  if (a === -1 || f === -1) return null
  return { start: Math.min(a, f), end: Math.max(a, f) }
}

/** The inclusive slice of ids in array order (empty when the range is invalid). */
export function rangeIds(orderedIds: string[], range: CopyRange): string[] {
  const idx = rangeIndices(orderedIds, range)
  if (!idx) return []
  return orderedIds.slice(idx.start, idx.end + 1)
}

/** Whole-list range, or null when the list is empty. */
export function selectAllRange(orderedIds: string[]): CopyRange | null {
  if (orderedIds.length === 0) return null
  return { anchorId: orderedIds[0], focusId: orderedIds[orderedIds.length - 1] }
}

/** Drop the selection if an endpoint vanished (retraction, conversation switch). */
export function pruneRange(range: CopyRange | null, orderedIds: string[]): CopyRange | null {
  if (!range) return null
  if (orderedIds.indexOf(range.anchorId) === -1 || orderedIds.indexOf(range.focusId) === -1) {
    return null
  }
  return range
}

/** Pure state transition. extendTo begins the range when state is null, otherwise keeps the
 *  anchor and moves the focus; an unknown id is ignored. */
export function selectionReducer(
  state: CopyRange | null,
  action: SelectionAction,
  orderedIds: string[],
): CopyRange | null {
  switch (action.type) {
    case 'clear':
      return null
    case 'selectAll':
      return selectAllRange(orderedIds)
    case 'extendTo':
      if (orderedIds.indexOf(action.id) === -1) return state
      if (!state) return { anchorId: action.id, focusId: action.id }
      return { anchorId: state.anchorId, focusId: action.id }
  }
}

/** Slice messages to the range and map each to clipboard metadata, ready for buildCopyText.
 *  Pure given a pure formatForCopy. */
export function collectRangeMeta<T extends { id: string }>(
  messages: T[],
  range: CopyRange,
  formatForCopy: (m: T) => CopyMessageMeta,
): CopyMessageMeta[] {
  const idx = rangeIndices(
    messages.map((m) => m.id),
    range,
  )
  if (!idx) return []
  return messages.slice(idx.start, idx.end + 1).map(formatForCopy)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/utils/messageRangeSelection.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/messageRangeSelection.ts apps/fluux/src/utils/messageRangeSelection.test.ts
git commit -m "feat(copy): pure range-selection core for bulk message copy"
```

---

## Task 2: i18n keys for the selection bar and copy toast

**Files:**
- Modify: `apps/fluux/src/i18n/locales/*.json` (33 files) — add `chat.selection`
- (Temporary helper script, not committed)

**Interfaces:**
- Produces the i18n keys consumed by Task 3 (toast) and Task 4 (bar): `chat.selection.count` ("{{num}} selected"), `chat.selection.copy`, `chat.selection.done`, `chat.selection.copied`.

- [ ] **Step 1: Create the one-off insertion script**

Create `scripts/add-selection-i18n.mjs` (repo root; deleted in Step 4, never committed):

```js
// One-off: insert chat.selection.* into every locale file as the first child of `chat`,
// preserving the existing 4-space formatting (textual insert, no JSON re-stringify).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'apps/fluux/src/i18n/locales'

const MAP = {
  ar: { count: '{{num}} محدد', copy: 'نسخ', done: 'تم', copied: 'تم النسخ إلى الحافظة' },
  be: { count: 'Вылучана: {{num}}', copy: 'Капіяваць', done: 'Гатова', copied: 'Скапіявана ў буфер абмену' },
  bg: { count: '{{num}} избрани', copy: 'Копирай', done: 'Готово', copied: 'Копирано в клипборда' },
  ca: { count: '{{num}} seleccionats', copy: 'Copia', done: 'Fet', copied: 'Copiat al porta-retalls' },
  cs: { count: 'Vybráno: {{num}}', copy: 'Kopírovat', done: 'Hotovo', copied: 'Zkopírováno do schránky' },
  da: { count: '{{num}} valgt', copy: 'Kopiér', done: 'Færdig', copied: 'Kopieret til udklipsholder' },
  de: { count: '{{num}} ausgewählt', copy: 'Kopieren', done: 'Fertig', copied: 'In die Zwischenablage kopiert' },
  el: { count: '{{num}} επιλεγμένα', copy: 'Αντιγραφή', done: 'Τέλος', copied: 'Αντιγράφηκε στο πρόχειρο' },
  en: { count: '{{num}} selected', copy: 'Copy', done: 'Done', copied: 'Copied to clipboard' },
  es: { count: '{{num}} seleccionados', copy: 'Copiar', done: 'Listo', copied: 'Copiado al portapapeles' },
  et: { count: '{{num}} valitud', copy: 'Kopeeri', done: 'Valmis', copied: 'Kopeeritud lõikelauale' },
  fi: { count: '{{num}} valittu', copy: 'Kopioi', done: 'Valmis', copied: 'Kopioitu leikepöydälle' },
  fr: { count: '{{num}} sélectionnés', copy: 'Copier', done: 'Terminé', copied: 'Copié dans le presse-papiers' },
  ga: { count: '{{num}} roghnaithe', copy: 'Cóipeáil', done: 'Déanta', copied: 'Cóipeáilte chuig an ngearrthaisce' },
  he: { count: '{{num}} נבחרו', copy: 'העתק', done: 'סיום', copied: 'הועתק ללוח' },
  hr: { count: 'Odabrano: {{num}}', copy: 'Kopiraj', done: 'Gotovo', copied: 'Kopirano u međuspremnik' },
  hu: { count: '{{num}} kijelölve', copy: 'Másolás', done: 'Kész', copied: 'Vágólapra másolva' },
  is: { count: '{{num}} valin', copy: 'Afrita', done: 'Lokið', copied: 'Afritað á klippiborð' },
  it: { count: '{{num}} selezionati', copy: 'Copia', done: 'Fatto', copied: 'Copiato negli appunti' },
  lt: { count: 'Pasirinkta: {{num}}', copy: 'Kopijuoti', done: 'Atlikta', copied: 'Nukopijuota į iškarpinę' },
  lv: { count: 'Atlasīti: {{num}}', copy: 'Kopēt', done: 'Gatavs', copied: 'Nokopēts starpliktuvē' },
  mt: { count: '{{num}} magħżula', copy: 'Ikkopja', done: 'Lest', copied: 'Ikkupjat fil-clipboard' },
  nb: { count: '{{num}} valgt', copy: 'Kopier', done: 'Ferdig', copied: 'Kopiert til utklippstavlen' },
  nl: { count: '{{num}} geselecteerd', copy: 'Kopiëren', done: 'Klaar', copied: 'Gekopieerd naar klembord' },
  pl: { count: 'Zaznaczono: {{num}}', copy: 'Kopiuj', done: 'Gotowe', copied: 'Skopiowano do schowka' },
  pt: { count: '{{num}} selecionadas', copy: 'Copiar', done: 'Concluído', copied: 'Copiado para a área de transferência' },
  ro: { count: '{{num}} selectate', copy: 'Copiază', done: 'Gata', copied: 'Copiat în clipboard' },
  ru: { count: 'Выбрано: {{num}}', copy: 'Копировать', done: 'Готово', copied: 'Скопировано в буфер обмена' },
  sk: { count: 'Vybraté: {{num}}', copy: 'Kopírovať', done: 'Hotovo', copied: 'Skopírované do schránky' },
  sl: { count: 'Izbrano: {{num}}', copy: 'Kopiraj', done: 'Končano', copied: 'Kopirano v odložišče' },
  sv: { count: '{{num}} markerade', copy: 'Kopiera', done: 'Klar', copied: 'Kopierat till urklipp' },
  uk: { count: 'Вибрано: {{num}}', copy: 'Копіювати', done: 'Готово', copied: 'Скопійовано до буфера обміну' },
  'zh-CN': { count: '已选择 {{num}} 条', copy: '复制', done: '完成', copied: '已复制到剪贴板' },
}

const anchor = '    "chat": {\n'
for (const [code, v] of Object.entries(MAP)) {
  const file = join(dir, `${code}.json`)
  let text = readFileSync(file, 'utf8')
  if (text.includes('"selection": {')) continue // idempotent
  if (!text.includes(anchor)) throw new Error(`no "chat" anchor in ${code}.json`)
  const block =
    '        "selection": {\n' +
    `            "count": ${JSON.stringify(v.count)},\n` +
    `            "copy": ${JSON.stringify(v.copy)},\n` +
    `            "done": ${JSON.stringify(v.done)},\n` +
    `            "copied": ${JSON.stringify(v.copied)}\n` +
    '        },\n'
  writeFileSync(file, text.replace(anchor, anchor + block))
}
console.log(`Inserted chat.selection into ${Object.keys(MAP).length} locales`)
```

- [ ] **Step 2: Run the script**

Run: `node scripts/add-selection-i18n.mjs`
Expected: `Inserted chat.selection into 33 locales`. Then `git status --short apps/fluux/src/i18n/locales | wc -l` shows `33`.

- [ ] **Step 3: Run the i18n parity test to verify completeness**

Run: `cd apps/fluux && npx vitest run src/i18n/i18n.test.ts`
Expected: PASS — every locale has the 4 new keys (parity), none empty. If a locale fails "missing key", the anchor replace did not match; inspect that file's `"chat": {` line.

- [ ] **Step 4: Delete the helper and commit only the locale changes**

```bash
rm scripts/add-selection-i18n.mjs
git add apps/fluux/src/i18n/locales
git commit -m "i18n(copy): add chat.selection keys (count, copy, done, copied) to all locales"
```

---

## Task 3: Selection hook

**Files:**
- Create: `apps/fluux/src/hooks/useMessageRangeSelection.ts`
- Test: `apps/fluux/src/hooks/useMessageRangeSelection.test.tsx`
- Modify: `apps/fluux/src/hooks/index.ts`

**Interfaces:**
- Consumes: Task 1 (`CopyRange`, `rangeIds`, `selectAllRange`, `pruneRange`, `selectionReducer`, `collectRangeMeta`), `buildCopyText`, `CopyMessageMeta`, `useToastStore`, Task 2 key `chat.selection.copied`.
- Produces:
  ```ts
  useMessageRangeSelection<T extends { id: string }>(opts: {
    containerRef: React.RefObject<HTMLElement | null>
    messages: T[]
    formatForCopy?: (m: T) => CopyMessageMeta
    conversationId: string
    enabled?: boolean
  }): {
    copySelectedIds: Set<string>
    selectionCount: number
    isSelecting: boolean
    selectAll: () => void
    extendTo: (id: string) => void
    clearSelection: () => void
    copySelected: () => void
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/hooks/useMessageRangeSelection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMessageRangeSelection } from './useMessageRangeSelection'
import { useToastStore } from '@/stores/toastStore'

// Deterministic i18n: return the key (or interpolate num) without app i18n init.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { num?: number }) => (o?.num !== undefined ? `${o.num} selected` : k) }),
}))

const MESSAGES = [
  { id: 'a', from: 'Alice', time: '10:00', body: 'one', date: '2024-01-15' },
  { id: 'b', from: 'Bob', time: '10:01', body: 'two', date: '2024-01-15' },
  { id: 'c', from: 'Alice', time: '10:02', body: 'three', date: '2024-01-15' },
]
const fmt = (m: (typeof MESSAGES)[number]) => ({ id: m.id, from: m.from, time: m.time, body: m.body, date: m.date })

let container: HTMLDivElement
let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  container.className = 'focus-zone'
  container.tabIndex = -1
  // Rows the delegated mousedown resolves against.
  for (const m of MESSAGES) {
    const row = document.createElement('div')
    row.setAttribute('data-message-id', m.id)
    container.appendChild(row)
  }
  document.body.appendChild(container)
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  // The hook calls window.getSelection()?.removeAllRanges() on select-all / shift-extend.
  vi.spyOn(window, 'getSelection').mockReturnValue({ removeAllRanges: () => {} } as unknown as Selection)
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  container.remove()
  vi.restoreAllMocks()
})

function setup() {
  const containerRef = { current: container } as React.RefObject<HTMLElement>
  return renderHook(() =>
    useMessageRangeSelection({ containerRef, messages: MESSAGES, formatForCopy: fmt, conversationId: 'c1' }),
  )
}

describe('useMessageRangeSelection', () => {
  it('selectAll selects every loaded message', () => {
    const { result } = setup()
    act(() => result.current.selectAll())
    expect(result.current.selectionCount).toBe(3)
    expect([...result.current.copySelectedIds]).toEqual(['a', 'b', 'c'])
    expect(result.current.isSelecting).toBe(true)
  })

  it('extendTo builds a contiguous range from the first extend point', () => {
    const { result } = setup()
    act(() => result.current.extendTo('b'))
    act(() => result.current.extendTo('c'))
    expect([...result.current.copySelectedIds]).toEqual(['b', 'c'])
  })

  it('Cmd+A keydown selects all when focus is within the list', () => {
    const { result } = setup()
    container.focus()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    })
    expect(result.current.selectionCount).toBe(3)
  })

  it('Shift+mousedown on a row extends the range', () => {
    const { result } = setup()
    act(() => result.current.extendTo('a'))
    act(() => {
      container
        .querySelector('[data-message-id="c"]')!
        .dispatchEvent(new MouseEvent('mousedown', { shiftKey: true, bubbles: true }))
    })
    expect([...result.current.copySelectedIds]).toEqual(['a', 'b', 'c'])
  })

  it('copySelected writes buildCopyText output and shows a toast', async () => {
    const { result } = setup()
    act(() => result.current.selectAll())
    await act(async () => {
      result.current.copySelected()
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toBe(
      ['— Monday, January 15, 2024 —', 'Alice 10:00', 'one', 'Bob 10:01', 'two', 'Alice 10:02', 'three'].join('\n'),
    )
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('chat.selection.copied')
  })

  it('clearSelection resets', () => {
    const { result } = setup()
    act(() => result.current.selectAll())
    act(() => result.current.clearSelection())
    expect(result.current.isSelecting).toBe(false)
    expect(result.current.selectionCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useMessageRangeSelection.test.tsx`
Expected: FAIL — `Failed to resolve import "./useMessageRangeSelection"`.

- [ ] **Step 3: Write the hook**

Create `apps/fluux/src/hooks/useMessageRangeSelection.ts`:

```ts
/**
 * useMessageRangeSelection — virtualization-friendly bulk-copy selection.
 *
 * Holds a contiguous "copy range" over the in-memory message array, decoupled from the
 * browser's text selection (which cannot span virtualized/unmounted rows). Owns the
 * imperative entry points:
 *   - window keydown: Cmd/Ctrl+A (select all loaded), Escape (clear), Cmd/Ctrl+C (copy),
 *     gated to when focus is within the list's `.focus-zone` and not in an input/textarea.
 *   - delegated `mousedown` on the scroll container: Shift-click extends the range (and
 *     suppresses native shift text-extend); a plain click clears any active range so native
 *     text selection resumes.
 * Copy reconstructs text from the array (never the DOM) via collectRangeMeta + buildCopyText.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { buildCopyText, type CopyMessageMeta } from '@/utils/buildCopyText'
import {
  type CopyRange,
  rangeIds,
  selectAllRange,
  pruneRange,
  selectionReducer,
  collectRangeMeta,
} from '@/utils/messageRangeSelection'
import { useToastStore } from '@/stores/toastStore'

interface Options<T extends { id: string }> {
  containerRef: RefObject<HTMLElement | null>
  messages: T[]
  formatForCopy?: (m: T) => CopyMessageMeta
  conversationId: string
  enabled?: boolean
}

export function useMessageRangeSelection<T extends { id: string }>({
  containerRef,
  messages,
  formatForCopy,
  conversationId,
  enabled = true,
}: Options<T>) {
  const { t } = useTranslation()
  const [range, setRange] = useState<CopyRange | null>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)

  const orderedIds = useMemo(() => messages.map((m) => m.id), [messages])

  // Latest-refs so the imperative listeners read current data without re-binding per message.
  const rangeRef = useRef(range)
  rangeRef.current = range
  const orderedIdsRef = useRef(orderedIds)
  orderedIdsRef.current = orderedIds
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const formatRef = useRef(formatForCopy)
  formatRef.current = formatForCopy
  const tRef = useRef(t)
  tRef.current = t

  const copySelectedIds = useMemo(
    () => new Set(range ? rangeIds(orderedIds, range) : []),
    [orderedIds, range],
  )

  // Prune when the message set changes (a selected message was retracted/removed).
  useEffect(() => {
    setRange((r) => pruneRange(r, orderedIds))
  }, [orderedIds])

  // Clear when switching conversations/rooms.
  useEffect(() => {
    setRange(null)
  }, [conversationId])

  // Track the container element in state so listeners (re)bind when it mounts.
  useEffect(() => {
    if (containerRef.current !== container) setContainer(containerRef.current)
  }, [containerRef, container])

  const selectAll = () => setRange(selectAllRange(orderedIdsRef.current))
  const clearSelection = () => setRange(null)
  const extendTo = (id: string) =>
    setRange((r) => selectionReducer(r, { type: 'extendTo', id }, orderedIdsRef.current))

  const copySelected = () => {
    const r = rangeRef.current
    const format = formatRef.current
    if (!r || !format) return
    const ids = rangeIds(orderedIdsRef.current, r)
    if (ids.length === 0) return
    const msgs = messagesRef.current
    let text: string | null
    if (ids.length === 1) {
      const only = msgs.find((m) => m.id === ids[0])
      text = only ? format(only).body || null : null
    } else {
      text = buildCopyText(collectRangeMeta(msgs, r, format))
    }
    if (!text) return
    void navigator.clipboard
      ?.writeText(text)
      .then(() => useToastStore.getState().addToast('success', tRef.current('chat.selection.copied')))
      .catch(() => {
        /* clipboard unavailable / denied: leave the selection so the user can retry */
      })
  }

  useEffect(() => {
    if (!enabled || !container) return

    const isEditable = (el: Element | null) =>
      !!el &&
      el instanceof HTMLElement &&
      (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')

    const focusWithinList = () => {
      const active = document.activeElement
      const zone = container.closest('.focus-zone')
      return container.contains(active) || (!!zone && zone.contains(active))
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!focusWithinList() || isEditable(document.activeElement)) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        window.getSelection()?.removeAllRanges()
        selectAll()
      } else if (e.key === 'Escape') {
        if (rangeRef.current) {
          e.preventDefault()
          e.stopPropagation()
          clearSelection()
        }
      } else if (mod && (e.key === 'c' || e.key === 'C')) {
        if (rangeRef.current) {
          e.preventDefault()
          copySelected()
        }
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      const rowEl = (e.target as Element)?.closest?.('[data-message-id]') as HTMLElement | null
      const id = rowEl?.getAttribute('data-message-id') || ''
      if (e.shiftKey && id) {
        e.preventDefault() // suppress the browser's shift text-extend
        window.getSelection()?.removeAllRanges()
        extendTo(id)
      } else if (!e.shiftKey && rangeRef.current) {
        clearSelection() // a fresh plain click drops the range; native selection resumes
      }
    }

    window.addEventListener('keydown', onKeyDown)
    container.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      container.removeEventListener('mousedown', onMouseDown)
    }
  }, [enabled, container])

  return {
    copySelectedIds,
    selectionCount: copySelectedIds.size,
    isSelecting: range !== null,
    selectAll,
    extendTo,
    clearSelection,
    copySelected,
  }
}
```

- [ ] **Step 4: Export the hook from the barrel**

In `apps/fluux/src/hooks/index.ts`, add after the `useMessageCopyFormatter` export (line 17):

```ts
export { useMessageRangeSelection } from './useMessageRangeSelection'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useMessageRangeSelection.test.tsx`
Expected: PASS (6 cases).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/hooks/useMessageRangeSelection.ts apps/fluux/src/hooks/useMessageRangeSelection.test.tsx apps/fluux/src/hooks/index.ts
git commit -m "feat(copy): useMessageRangeSelection hook (Cmd+A, shift-click, clipboard)"
```

---

## Task 4: Selection bar component

**Files:**
- Create: `apps/fluux/src/components/conversation/MessageSelectionBar.tsx`
- Test: `apps/fluux/src/components/conversation/MessageSelectionBar.test.tsx`

**Interfaces:**
- Consumes: Task 2 keys (`chat.selection.count|copy|done`), lucide-react icons.
- Produces: `MessageSelectionBar({ count, onCopy, onClear }: { count: number; onCopy: () => void; onClear: () => void })` — renders null when `count <= 0`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/conversation/MessageSelectionBar.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageSelectionBar } from './MessageSelectionBar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { num?: number }) => (o?.num !== undefined ? `${o.num} selected` : k),
  }),
}))

describe('MessageSelectionBar', () => {
  it('renders nothing when count is 0', () => {
    const { container } = render(<MessageSelectionBar count={0} onCopy={vi.fn()} onClear={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the count and fires callbacks', () => {
    const onCopy = vi.fn()
    const onClear = vi.fn()
    render(<MessageSelectionBar count={3} onCopy={onCopy} onClear={onClear} />)
    expect(screen.getByText('3 selected')).toBeTruthy()
    fireEvent.click(screen.getByText('chat.selection.copy'))
    expect(onCopy).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('chat.selection.done'))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageSelectionBar.test.tsx`
Expected: FAIL — cannot resolve `./MessageSelectionBar`.

- [ ] **Step 3: Write the component**

Create `apps/fluux/src/components/conversation/MessageSelectionBar.tsx`:

```tsx
/**
 * MessageSelectionBar — floating bar shown while a bulk-copy range is active. Centered at
 * the bottom of the message list (distinct from the end-aligned scroll-to-bottom FAB).
 */
import { useTranslation } from 'react-i18next'
import { Copy } from 'lucide-react'

interface Props {
  count: number
  onCopy: () => void
  onClear: () => void
}

export function MessageSelectionBar({ count, onCopy, onClear }: Props) {
  const { t } = useTranslation()
  if (count <= 0) return null
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 py-2 rounded-full bg-fluux-bg border border-fluux-border shadow-lg">
      <span className="text-sm text-fluux-text">{t('chat.selection.count', { num: count })}</span>
      <button
        onClick={onCopy}
        className="flex items-center gap-1 px-2.5 py-1 text-sm rounded-full text-fluux-text hover:bg-fluux-hover transition-colors"
      >
        <Copy className="size-4" />
        {t('chat.selection.copy')}
      </button>
      <button
        onClick={onClear}
        className="px-2.5 py-1 text-sm rounded-full text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover transition-colors"
      >
        {t('chat.selection.done')}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageSelectionBar.test.tsx`
Expected: PASS (2 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageSelectionBar.tsx apps/fluux/src/components/conversation/MessageSelectionBar.test.tsx
git commit -m "feat(copy): MessageSelectionBar floating count + copy + done"
```

---

## Task 5: Wire selection into MessageList + row-highlight CSS

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx`
- Modify: `apps/fluux/src/index.css`

**Interfaces:**
- Consumes: Task 3 (`useMessageRangeSelection`), Task 4 (`MessageSelectionBar`), Task 2 keys, the `copy-selected` CSS class.
- Produces: end-user behavior (no new exported symbols).

- [ ] **Step 1: Add the row-highlight CSS**

Append to the end of `apps/fluux/src/index.css`:

```css
/* Bulk-copy selection highlight. Decoupled from native text selection (which cannot span
   virtualized/unmounted rows); driven by the `copy-selected` class on `.message-row`
   (MessageList). Uses the Aurora selection token so it adapts across themes. */
.message-row.copy-selected {
    background-color: var(--fluux-selection-bg);
    border-radius: 0.5rem;
}
```

- [ ] **Step 2: Import the hook and bar in MessageList**

In `apps/fluux/src/components/conversation/MessageList.tsx`, change the hooks import (line 17) from:

```ts
import { useMessageCopyFormatter } from '@/hooks'
```

to:

```ts
import { useMessageCopyFormatter, useMessageRangeSelection } from '@/hooks'
```

And add to the local imports near the other `./` component imports (after the `MessageSelectionBar`-adjacent group; place it right after the `import { Tooltip } from '../Tooltip'` line, line 34):

```ts
import { MessageSelectionBar } from './MessageSelectionBar'
```

- [ ] **Step 3: Call the hook and add a row-class helper**

In `MessageList.tsx`, immediately after the existing `useMessageCopyFormatter({ ... })` call (the block ending at line 307), add:

```ts
  // Virtualization-friendly bulk copy: Cmd/Ctrl+A selects the whole loaded conversation,
  // Shift-click defines a range; copy reconstructs from the in-memory array via the caller's
  // formatter. Decoupled from DOM text selection (which can't span unmounted rows).
  const { copySelectedIds, selectionCount, copySelected, clearSelection } =
    useMessageRangeSelection({
      containerRef: scrollContainerRef,
      messages: deduplicatedMessages,
      formatForCopy: formatMessageForCopy,
      conversationId,
      enabled: !staticMode,
    })

  const rowClass = (id: string) =>
    copySelectedIds.has(id) ? 'message-row copy-selected' : 'message-row'
```

- [ ] **Step 4: Apply the row class on the virtualized path**

In the `renderItem` `case 'message'` block, change the row `<div>` (lines 350-357) from:

```tsx
        return (
          <div
            className="message-row"
            data-message-id={msg.id}
            data-stanza-id={msg.stanzaId}
            data-origin-id={msg.originId}
            style={msg.id === lastSentMessageId ? { animation: 'message-send 300ms ease-out' } : undefined}
          >
```

to:

```tsx
        return (
          <div
            className={rowClass(msg.id)}
            data-message-id={msg.id}
            data-stanza-id={msg.stanzaId}
            data-origin-id={msg.originId}
            style={msg.id === lastSentMessageId ? { animation: 'message-send 300ms ease-out' } : undefined}
          >
```

- [ ] **Step 5: Apply the row class on the legacy path**

In the legacy grouped render, change the row `<div>` (lines 479-485) from:

```tsx
                  <div
                    key={rowKey}
                    className="message-row"
                    data-message-id={msg.id}
                    data-stanza-id={msg.stanzaId}
                    data-origin-id={msg.originId}
                    style={msg.id === lastSentMessageId ? { animation: 'message-send 300ms ease-out' } : undefined}
                  >
```

to:

```tsx
                  <div
                    key={rowKey}
                    className={rowClass(msg.id)}
                    data-message-id={msg.id}
                    data-stanza-id={msg.stanzaId}
                    data-origin-id={msg.originId}
                    style={msg.id === lastSentMessageId ? { animation: 'message-send 300ms ease-out' } : undefined}
                  >
```

- [ ] **Step 6: Render the selection bar**

In `MessageList.tsx`, add the bar right after the scroll-to-bottom FAB wrapper `</div>` (line 534), before the outer `</div>` that closes the `relative flex-1` container (line 535):

```tsx
      <MessageSelectionBar count={selectionCount} onCopy={copySelected} onClear={clearSelection} />
```

- [ ] **Step 7: Typecheck and run the related tests**

Run: `npm run typecheck`
Expected: PASS (no errors).

Run: `cd apps/fluux && npx vitest run src/components/conversation src/hooks/useMessageRangeSelection.test.tsx`
Expected: PASS (existing MessageList-area tests plus the new ones; no stderr).

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageList.tsx apps/fluux/src/index.css
git commit -m "feat(copy): wire bulk-copy selection into MessageList (highlight + bar)"
```

---

## Task 6: Full verification + manual confirmation

**Files:** none (verification only).

- [ ] **Step 1: Typecheck, lint, and full test suite**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run lint`
Expected: PASS (no new errors in the touched files).

Run: `cd apps/fluux && npx vitest run`
Expected: PASS, no stderr. (Confirms i18n parity, the new pure/hook/component tests, and that no existing MessageList/ChatView/RoomView test regressed.)

- [ ] **Step 2: Manual confirmation in demo mode (preview tools)**

Start the dev server (preview_start) and open `http://localhost:5173/demo.html?tutorial=false`. Open a conversation with enough history to virtualize, then verify:
1. Focus the message list, press Cmd/Ctrl+A: all loaded rows highlight with the selection token; the bar shows "N selected".
2. Click "Copy": a "Copied to clipboard" toast appears; paste elsewhere shows the date-grouped `buildCopyText` output.
3. Shift-click message X then shift-click message Y far above (scrolling between): the inclusive range highlights even across rows that scrolled through the window; Copy includes the whole range.
4. Press Esc or click "Done" or plain-click a message: selection clears.
5. Focus the composer and press Cmd/Ctrl+A: it selects composer text (the list does not hijack it).
6. Switch conversation: selection resets.

Capture a screenshot (preview_screenshot) of the active selection + bar as proof.

- [ ] **Step 3: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(copy): verification fixes for bulk message copy"
```

(Skip if Step 1-2 passed with no changes.)

---

## Self-Review notes (author)

- **Spec coverage:** §3 model → Task 1; §4 pure core → Task 1; §5 hook → Task 3; §6 wiring (Cmd+A/Esc/Cmd+C, shift-click, highlight, bar, no-conflict) → Tasks 3+5; §7 bar/CSS/i18n/toast → Tasks 2+4+5; §8 edge cases (prune, conversation switch, plain-drag clear, single-message, composer guard, empty list) → Task 1 (`pruneRange`, `selectAllRange`) + Task 3 (effects + guards); §10 testing → Tasks 1,3,4 + Task 6 parity/manual. §9 touch is intentionally out of scope.
- **Type consistency:** `CopyRange`, `rangeIds`, `selectAllRange`, `pruneRange`, `selectionReducer`, `collectRangeMeta` names/signatures identical across Tasks 1 and 3; hook return shape used by Task 5 matches Task 3's `Produces`.
- **i18n note:** `count` uses `{{num}}` (not `{{count}}`) to avoid i18next pluralization, so one key per locale satisfies the parity test. The `copied` toast carries no count, so no plural handling is needed anywhere.
- **Known limitation (carried from spec):** copy depends on a secure context for `navigator.clipboard` (Tauri webview and localhost qualify); failures are caught silently and the selection is retained.
