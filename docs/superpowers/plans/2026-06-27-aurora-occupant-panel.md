# Aurora Occupant Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the MUC members panel (`OccupantPanel`) up to the Aurora identity — occupant names + fallback avatars in the same per-person hue the message list uses, ringed presence dots, small-caps hairline section labels, and a refined on-brand role tag — without losing the panel's per-row render-perf guarantees.

**Architecture:** Presentation-only changes in two files. `Avatar` gains two backward-compatible opt-in props (a fallback-letter color and a presence halo) plus a small `bestTextColor` hex helper. `OccupantPanel`/`OccupantRow` reads the theme mode once, threads `isDark` through the memoized row, and derives each occupant's name color + avatar fill from `auroraSenderColor(primaryNick, isDark)` — the exact value the message list uses, so a person is the same color in both surfaces.

**Tech Stack:** React + TypeScript, Tailwind + CSS custom properties, lucide-react, Vitest + Testing Library. No SDK changes.

## Global Constraints

- **Identity parity (binding):** an occupant's name color and fallback-avatar fill both come from `auroraSenderColor(group.primaryNick, isDark)` — the same call (keyed on the nick) the message list makes — so colors match byte-for-byte. Self uses `var(--fluux-text-self)` (name) and `var(--fluux-bg-accent)` (avatar), unchanged.
- **Readable letters (binding):** the fallback avatar letter must clear WCAG AA on its fill in every theme/mode. Achieved with `bestTextColor` (best of black/white), which is ≥4.5:1 for any fill by construction; guarded.
- **Render-perf — preserve exactly:** keep the `OccupantRow` `memo` + `occupantRowPropsEqual` (occupant object-ref identity), `useContactIdentities()` for `contactsByJid`, `useMemo` on `groupedOccupants`, and `@tanstack/react-virtual`. New colors are derived ref-stably (plain strings from the stable `primaryNick` + the threaded `isDark`), never threaded as fresh object props. The new `isDark` prop is added to `OccupantRowProps`, `occupantRowPropsEqual`, and the memo test.
- **No em-dashes / en-dashes in user-facing text:** the section-header count separator currently uses a literal `—` (`OccupantPanel.tsx:541/564/604`). The new header drops it (count rendered in the accent, no dash).
- **Aurora tokens, not hardcoded Tailwind colors:** the affiliation badge's `text-amber-600 dark:text-amber-400` is replaced with Aurora-tokenized styling.
- **Scope:** `OccupantPanel.tsx` + `Avatar.tsx` (+ `contrastColor.ts` helper). `MemberList` is out of scope. No SDK/semantic changes.

## File Structure

- `apps/fluux/src/utils/contrastColor.ts` — add `bestTextColor(hex)`.
- `apps/fluux/src/components/Avatar.tsx` — add `fallbackTextColor?` + `presenceHalo?` opt-in props.
- `apps/fluux/src/components/OccupantPanel.tsx` — identity name color + avatar hue + `isDark` threading; section-header redesign; role-tag redesign.
- Tests: `contrastColor.test.ts`, `Avatar.test.tsx`, `OccupantPanel.test.tsx`, `OccupantPanel.memo.test.tsx`, a new `apps/fluux/src/themes/occupantAvatarContrast.test.ts`, and `scripts/screenshots.ts`.

---

### Task 1: Avatar opt-in primitives + `bestTextColor` helper

**Files:**
- Modify: `apps/fluux/src/utils/contrastColor.ts`
- Modify: `apps/fluux/src/components/Avatar.tsx`
- Test: `apps/fluux/src/utils/contrastColor.test.ts` (create if absent), `apps/fluux/src/components/Avatar.test.tsx`

**Interfaces:**
- Produces: `bestTextColor(hex: string): '#ffffff' | '#000000'` (exported from `contrastColor.ts`). Avatar props `fallbackTextColor?: string` (color for the fallback letter; default `'#ffffff'`, preserving current behavior) and `presenceHalo?: boolean` (default `false`; adds a soft colored glow behind the presence dot).
- Consumes: nothing from later tasks.

- [ ] **Step 1: Write the failing test for `bestTextColor`**

Add to `apps/fluux/src/utils/contrastColor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { bestTextColor } from './contrastColor'

describe('bestTextColor', () => {
  it('picks black on a light fill, white on a dark fill', () => {
    expect(bestTextColor('#A9B4FF')).toBe('#000000') // light periwinkle (dark-mode sender hue)
    expect(bestTextColor('#1A2238')).toBe('#ffffff') // deep navy
  })
  it('falls back to white for a non-hex input', () => {
    expect(bestTextColor('var(--fluux-bg-accent)')).toBe('#ffffff')
    expect(bestTextColor('')).toBe('#ffffff')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/contrastColor.test.ts`
Expected: FAIL — `bestTextColor` is not exported.

- [ ] **Step 3: Implement `bestTextColor`**

Append to `apps/fluux/src/utils/contrastColor.ts`:

```ts
/**
 * Pick the better of black/white as a readable foreground on a solid hex fill.
 * Returns whichever of #000/#fff has the higher WCAG contrast ratio against the
 * fill. By construction the chosen ratio is >= ~4.58:1 for any fill (the
 * crossover sits at relative luminance ~0.18), so a fallback-avatar letter
 * coloured this way always clears AA. Non-hex inputs (e.g. CSS vars) -> white.
 */
export function bestTextColor(hex: string): '#ffffff' | '#000000' {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '#ffffff'
  const int = parseInt(m[1], 16)
  const channels = [(int >> 16) & 255, (int >> 8) & 255, int & 255]
  const [r, g, b] = channels.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const contrastWhite = 1.05 / (L + 0.05)
  const contrastBlack = (L + 0.05) / 0.05
  return contrastBlack > contrastWhite ? '#000000' : '#ffffff'
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/contrastColor.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Avatar test**

Add to `apps/fluux/src/components/Avatar.test.tsx` (follow the file's existing render-test style):

```tsx
it('renders the fallback letter in fallbackTextColor when provided', () => {
  const { getByText } = render(
    <Avatar identifier="maya" name="Maya" fallbackColor="#A9B4FF" fallbackTextColor="#000000" />
  )
  const letter = getByText('M')
  expect(letter).toHaveStyle({ color: '#000000' })
})

it('defaults the fallback letter to white (back-compat)', () => {
  const { getByText } = render(<Avatar identifier="sam" name="Sam" />)
  expect(getByText('S')).toHaveStyle({ color: '#ffffff' })
})
```

- [ ] **Step 6: Run it, verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/Avatar.test.tsx`
Expected: FAIL — the letter is hardcoded `text-white`, so the first test's `color: #000000` assertion fails.

- [ ] **Step 7: Add the props + apply them in `Avatar.tsx`**

In the `AvatarProps` interface (after `fallbackColor?` at line ~89), add:

```ts
  /** Colour for the fallback letter. Defaults to white. Set to a best-contrast
   *  value (see bestTextColor) when fallbackColor is a light fill. */
  fallbackTextColor?: string
  /** Adds a soft colored glow behind the presence dot (Aurora members panel). */
  presenceHalo?: boolean
```

Destructure both in the component signature (alongside `fallbackColor`, `presenceBorderColor`, etc.), defaulting `presenceHalo = false`.

Replace the fallback-letter `<span>` (lines ~313–318) so the letter uses the prop:

```tsx
<span
  className={`${sizeClasses.text} font-semibold select-none`}
  style={{ color: fallbackTextColor ?? '#ffffff' }}
>
  {letter}
</span>
```

Replace the presence-dot `<div>` (lines ~322–328) to add the optional halo. Compute the glow from the same presence CSS var:

```tsx
{overlay ? (
  overlay
) : presenceColor && (
  <div
    className={`absolute ${sizeClasses.presence} rounded-full border-2 ${presenceBorderColor} ${presenceBgStyle ? '' : presenceColor} transition-colors duration-500 ease-in-out`}
    style={{
      ...presenceBgStyle,
      ...(presenceHalo && presenceBgStyle
        ? { boxShadow: `0 0 5px ${PRESENCE_CSS_VARS[resolvedPresence!]}` }
        : {}),
    }}
  />
)}
```

(`PRESENCE_CSS_VARS` and `resolvedPresence` already exist at lines ~229–234 / ~223.)

- [ ] **Step 8: Run it, verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/Avatar.test.tsx`
Expected: PASS (both new tests + the existing suite).

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/utils/contrastColor.ts apps/fluux/src/utils/contrastColor.test.ts apps/fluux/src/components/Avatar.tsx apps/fluux/src/components/Avatar.test.tsx
git -c commit.gpgsign=false commit -m "feat(avatar): opt-in fallback letter color + presence halo + bestTextColor"
```

---

### Task 2: Occupant identity colors (name + avatar hue + `isDark` threading)

**Files:**
- Modify: `apps/fluux/src/components/OccupantPanel.tsx`
- Test: `apps/fluux/src/components/OccupantPanel.test.tsx`, `apps/fluux/src/components/OccupantPanel.memo.test.tsx`

**Interfaces:**
- Consumes: `auroraSenderColor` (`@/utils/senderColor`), `bestTextColor` (`@/utils/contrastColor`), Avatar `fallbackTextColor`/`presenceHalo` (Task 1), `useTheme` (`@/hooks/useTheme`, returns `{ isDark }`).
- Produces: a new `isDark: boolean` member of `OccupantRowProps` (compared in `occupantRowPropsEqual`).

- [ ] **Step 1: Write the failing test — non-self name uses the sender color**

Add to `apps/fluux/src/components/OccupantPanel.test.tsx` (the file already mocks `Avatar`; extend that mock to expose `data-fallback-color`, and confirm `useTheme` is mocked to return `{ isDark: true }`). Assert the rendered non-self name carries the `auroraSenderColor` value:

```tsx
it('colors a non-self occupant name with its Aurora sender color', () => {
  // auroraSenderColor('Alice', true) computed in-test to compare exactly:
  const expected = auroraSenderColor('Alice', true)
  const { getByText } = renderPanel(/* a room with occupant nick 'Alice', self != Alice */)
  const name = getByText('Alice')
  expect(name).toHaveStyle({ color: expected })
})
```

(Import `auroraSenderColor` in the test; do NOT mock it — use the real value so the assertion proves parity. Use the panel's existing test render helper / room fixture.)

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/OccupantPanel.test.tsx`
Expected: FAIL — the name renders `text-fluux-text`, no inline color.

- [ ] **Step 3: Read the theme mode + thread it**

In `OccupantPanel.tsx`:
1. Import: `import { useTheme } from '@/hooks/useTheme'`, `import { auroraSenderColor } from '@/utils/senderColor'`, `import { bestTextColor } from '@/utils/contrastColor'`.
2. In the `OccupantPanel` component body, read once: `const { isDark } = useTheme()`.
3. Add `isDark: boolean` to `OccupantRowProps` (after `forceOffline`).
4. Add to `occupantRowPropsEqual` (in the `return (...)` chain): `prev.isDark === next.isDark &&`.
5. Pass `isDark={isDark}` everywhere `<OccupantRow ... />` is rendered (the role-grouped, offline, and ignored render sites).

- [ ] **Step 4: Apply the name color + avatar fill in `OccupantRow`**

Inside `OccupantRow`, after `isMe` is computed (line ~134), derive the identity color once (stable string from stable inputs):

```ts
const identityColor = isMe ? undefined : auroraSenderColor(group.primaryNick, isDark)
const nameColor = isMe ? 'var(--fluux-text-self)' : identityColor!
```

Update the name `<span>`s (lines ~196–213): drop `text-fluux-text`, add `style={{ color: nameColor }}`. For the self branch keep the ` (you)` suffix span as `text-fluux-muted font-normal`. For the non-self branch:

```tsx
<span className="truncate text-sm" style={{ color: nameColor }}>
  {group.primaryNick}
</span>
```

Update the `<Avatar>` (lines ~182–191):

```tsx
<Avatar
  identifier={group.primaryNick}
  name={group.primaryNick}
  avatarUrl={isMe ? (ownAvatar || undefined) : displayAvatar}
  size="sm"
  presence={getPresenceFromShow(group.bestPresence)}
  presenceBorderColor="border-fluux-sidebar"
  presenceHalo
  fallbackColor={isMe ? 'var(--fluux-bg-accent)' : identityColor}
  fallbackTextColor={isMe ? undefined : bestTextColor(identityColor!)}
  forceOffline={forceOffline}
/>
```

- [ ] **Step 5: Run it, verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/OccupantPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Update + run the memo test**

In `apps/fluux/src/components/OccupantPanel.memo.test.tsx`, add `isDark` to every `OccupantRowProps` fixture the test constructs (set `isDark: true`), and add one assertion: changing only `isDark` re-renders the row (props inequality), while an unrelated occupant ref-unchanged still bails. Run:

`cd apps/fluux && npx vitest run src/components/OccupantPanel.memo.test.tsx`
Expected: PASS — only the changed row (or, for an `isDark` flip, all rows) re-renders.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/OccupantPanel.tsx apps/fluux/src/components/OccupantPanel.test.tsx apps/fluux/src/components/OccupantPanel.memo.test.tsx
git -c commit.gpgsign=false commit -m "feat(occupants): identity-colored names + matching avatar hue (parity with message list)"
```

---

### Task 3: Section headers + role tag chrome

**Files:**
- Modify: `apps/fluux/src/components/OccupantPanel.tsx`
- Test: `apps/fluux/src/components/OccupantPanel.test.tsx`

**Interfaces:**
- Consumes: `--fluux-surface-divider`, `--fluux-text-accent` / `text-fluux-brand`, Aurora warning/accent tokens. No new exports.

- [ ] **Step 1: Write the failing tests**

Add to `OccupantPanel.test.tsx`:

```tsx
it('renders a hairline section header with the count in the accent and no em-dash', () => {
  const { getByText, container } = renderPanel(/* room with >=1 moderator */)
  const header = getByText(/moderators/i).closest('div')!
  expect(header.className).toMatch(/border-t/)        // hairline rule
  expect(header.textContent).not.toContain('—')        // no em-dash
})

it('does not use hardcoded amber for the owner affiliation badge', () => {
  const { container } = renderPanel(/* room with an owner */)
  expect(container.innerHTML).not.toContain('text-amber-600')
})
```

- [ ] **Step 2: Run, verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/OccupantPanel.test.tsx`
Expected: FAIL — current header has no `border-t` + uses `—`; owner badge uses `text-amber-600`.

- [ ] **Step 3: Redesign the section headers**

Replace the three header JSX sites (role-header ~536–543, offline ~560–565, ignored ~599–605). Pattern (apply to each, keeping each one's icon + label):

```tsx
<div className="px-4 pt-3 pb-1 mt-1 border-t border-[color:var(--fluux-surface-divider)] flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-fluux-muted">
  {getRoleIcon(item.role)}
  <span style={{ fontFamily: 'var(--fluux-font-display)' }}>{getRoleLabel(item.role)}</span>
  <span className="text-fluux-brand">{item.count}</span>
</div>
```

The display font is applied via inline `style={{ fontFamily: 'var(--fluux-font-display)' }}` (robust regardless of Tailwind config; if the project already has a `font-display`/`font-heading` utility, prefer it). Keep each header's existing icon: the offline header omits the role icon, the ignored header keeps `<EyeOff className="size-3" />`. Render the count as `<span className="text-fluux-brand">{count}</span>` (no `—`). Do not change the i18n label calls.

- [ ] **Step 4: Redesign the affiliation badge**

Replace `getAffiliationBadge` (lines ~50–73) with Aurora-tokenized tags. Owner = a tuned gold (`text-fluux-status-warning` if present, else `text-fluux-yellow`), admin = accent (`text-fluux-brand`), member = a quiet marker (`text-fluux-muted`). Keep the lucide icons, drop the hardcoded `text-amber-600 dark:text-amber-400`:

```tsx
function getAffiliationBadge(affiliation: string) {
  switch (affiliation) {
    case 'owner':
      return <span className="flex items-center text-fluux-yellow" title="owner"><Crown className="size-3" /></span>
    case 'admin':
      return <span className="flex items-center text-fluux-brand" title="admin"><Shield className="size-3" /></span>
    case 'member':
      return <span className="flex items-center text-fluux-muted" title="member"><UserCheck className="size-3" /></span>
    default:
      return null
  }
}
```

(If the implementer confirms a dedicated owner-gold Aurora token exists, prefer it over `text-fluux-yellow`. The `title` attributes are not user-facing prose; keep them lowercase or wire to i18n if the file already does so elsewhere — match the file's convention.)

- [ ] **Step 5: Run, verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/OccupantPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/OccupantPanel.tsx apps/fluux/src/components/OccupantPanel.test.tsx
git -c commit.gpgsign=false commit -m "feat(occupants): hairline small-caps section labels + Aurora role tags (drop em-dash, off-brand amber)"
```

---

### Task 4: Cross-theme letter guard + screenshots + verification

**Files:**
- Create: `apps/fluux/src/themes/occupantAvatarContrast.test.ts`
- Modify: `scripts/screenshots.ts`
- Verify: typecheck, lint, full suite

**Interfaces:**
- Consumes: `auroraSenderColor`, `bestTextColor`, `builtinThemes` + the `themeTokens`/contrast helpers mirrored from `themeContrast.test.ts`.

- [ ] **Step 1: Write the avatar-letter contrast guard**

Create `apps/fluux/src/themes/occupantAvatarContrast.test.ts`, mirroring `themeContrast.test.ts`'s sender-name guard (lines ~191–216) — reuse its `SENDER_SAMPLE_IDS` sampling and a local `contrast(fg, bg)`:

```ts
import { describe, it, expect } from 'vitest'
import { auroraSenderColor } from '../utils/senderColor'
import { bestTextColor } from '../utils/contrastColor'
// + the contrast(hexA, hexB) helper copied from themeContrast.test.ts

describe('occupant fallback-avatar letter contrast', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`letter clears AA on the avatar fill (${mode})`, () => {
      for (const id of SAMPLE_IDS) {
        const fill = auroraSenderColor(id, mode === 'dark')
        const letter = bestTextColor(fill)
        const ratio = contrast(letter, fill)
        expect(ratio, `${id}/${mode}: letter ${letter} on ${fill}`).toBeGreaterThanOrEqual(4.5)
      }
    })
  }
})
```

(The fill + letter are theme-independent — `auroraSenderColor` targets fixed luminances, not theme tokens — so a single dark/light sweep covers all themes. The name-color-on-panel contrast is already guarded by `themeContrast.test.ts`'s sender guard on `--fluux-chat-bg`; in Step 4 confirm the occupant panel background is that surface, else extend that guard.)

- [ ] **Step 2: Run, verify it passes**

Run: `cd apps/fluux && npx vitest run src/themes/occupantAvatarContrast.test.ts`
Expected: PASS (>= 4.5:1 for every sampled id, both modes).

- [ ] **Step 3: Add occupant-panel screenshot scenes**

In `scripts/screenshots.ts`, add scenes that open a room + show the occupant panel (reuse the existing room-selection + "Show Members" toggle helpers; the panel opens via the `RoomHeader` members button). Capture Aurora dark + light and gruvbox + dracula (use the existing `setTheme(page, themeId)` helper). Name them `5x-occupant-panel-<theme>`. No em-dashes in scene labels.

- [ ] **Step 4: Regenerate + eyeball + confirm the panel surface**

Run: `npm run screenshots`. Confirm the occupant names + fallback avatars share each person's hue, presence dots are ringed with the halo, section labels sit on hairlines, and everything is readable in light + dark + the accent themes. Read the occupant panel's container background class in `OccupantPanel.tsx`; confirm `auroraSenderColor` name contrast is covered by the existing `themeContrast` sender guard for that surface (it guards `--fluux-chat-bg`); if the panel uses a different bg token, extend that guard to the panel surface and re-run.

- [ ] **Step 5: Full verification**

Run from repo root: `npm run typecheck` (clean), `npm run lint` (0 errors), `npm test` (all pass, no stderr; incl. the new guard + `OccupantPanel.memo.test`).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/themes/occupantAvatarContrast.test.ts scripts/screenshots.ts screenshots/
git -c commit.gpgsign=false commit -m "test(occupants): cross-theme avatar-letter guard + occupant-panel screenshot scenes"
```

---

## Self-Review notes

- **Spec coverage:** names in identity color (Task 2) · matching-hue avatars + AA letter (Task 1 helper + Task 2 wiring) · ringed presence dots / halo (Task 1) · small-caps hairline labels (Task 3) · refined role tag (Task 3) · render-perf preserved (Task 2 memo threading + test) · theme-robust guard (Task 4) · MemberList out of scope (untouched). All covered.
- **Self vs others:** self keeps `--fluux-text-self` name + `--fluux-bg-accent` avatar (white letter via the `fallbackTextColor=undefined` default) — verified consistent across Tasks 1–2.
- **Type consistency:** `bestTextColor(hex): '#ffffff'|'#000000'`, `auroraSenderColor(id, isDark): string`, Avatar `fallbackTextColor?: string` / `presenceHalo?: boolean`, `OccupantRowProps.isDark: boolean` — names match across tasks.
- **No SDK change** → no `build:sdk` needed before typecheck.
