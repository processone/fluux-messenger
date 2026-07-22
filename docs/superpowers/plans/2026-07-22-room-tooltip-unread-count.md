# Room Row Tooltip Unread Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the unread message count as a headline line in the sidebar room row tooltip, and delete the untranslated tooltip currently attached to the activity dot.

**Architecture:** A new pure module `apps/fluux/src/utils/roomTooltip.ts` owns all tooltip string composition and state branching, replacing the inline `getTooltipContent` closure in `RoomsList`. It returns `{ headline, detail }`; `RoomsList` renders a single string when `headline` is `null` (today's exact behaviour) and a two-line node otherwise. The nested `Tooltip` around the activity dot is removed.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react, i18next / react-i18next, Tailwind.

**Spec:** [docs/superpowers/specs/2026-07-22-room-tooltip-unread-count-design.md](../specs/2026-07-22-room-tooltip-unread-count-design.md)

## Global Constraints

- The unread headline shows whenever `room.joined && room.unreadCount > 0`, **including when `mentionsCount > 0`**. It is never gated on mentions.
- `mentionsCount` must not appear in `roomTooltipParts`' input type. Excluding it makes the old gate structurally unrepresentable.
- The unread line is **not** colour-tinted. No `text-fluux-badge-strong`, no `roomActivityTone` in the tooltip.
- The detail line keeps its existing manual `rooms.user` / `rooms.users` singular-plural selection. Do not migrate it to i18next plurals.
- New i18n keys follow the established base-key convention: the **unsuffixed** key is the singular (i18next falls back to it when `_one` is absent), `_other` is the plural. Verified against a live i18next instance for `en` and `fr`.
- All 33 locales must gain the new key. `apps/fluux/src/i18n/i18n.test.ts` enforces parity on unsuffixed keys and fails the build otherwise.
- Locale files are written back with `json.dumps(d, ensure_ascii=False, indent=4) + "\n"`. Verified: all 33 files round-trip byte-identically under this format, so diffs stay minimal.
- No em-dash connectors in translated copy.
- Never include a Claude footer in commit messages.
- Before each commit: tests pass with no stderr, `npm run typecheck` and `npm run lint` pass.

---

### Task 1: `roomTooltipParts` pure module

**Files:**
- Create: `apps/fluux/src/utils/roomTooltip.ts`
- Test: `apps/fluux/src/utils/roomTooltip.test.ts`

**Interfaces:**
- Consumes: `Room` from `@fluux/sdk` (type only).
- Produces:
  - `type RoomTooltipRoom = Pick<Room, 'joined' | 'isJoining' | 'unreadCount' | 'occupants' | 'nickname'>`
  - `interface RoomTooltipParts { headline: string | null; detail: string }`
  - `function roomTooltipParts(room: RoomTooltipRoom, t: TranslateFn): RoomTooltipParts`
  - i18n key used: `rooms.unreadMessages`, called as `t('rooms.unreadMessages', { count })`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/utils/roomTooltip.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { roomTooltipParts, type RoomTooltipRoom } from './roomTooltip'

// Echoes the key back, with the interpolation options appended when present, so
// assertions can check both WHICH key was chosen and WHAT was interpolated
// without depending on real locale copy. Real plural resolution is covered in
// i18n.test.ts against the actual locale files.
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${JSON.stringify(options)})` : key

const occupants = (n: number) =>
  new Map(Array.from({ length: n }, (_, i) => [`user${i}`, {}])) as RoomTooltipRoom['occupants']

const makeRoom = (over: Partial<RoomTooltipRoom> = {}): RoomTooltipRoom => ({
  joined: true,
  isJoining: false,
  unreadCount: 0,
  occupants: occupants(2),
  nickname: 'me',
  ...over,
})

describe('roomTooltipParts', () => {
  it('announces the unread count as the headline', () => {
    const parts = roomTooltipParts(makeRoom({ unreadCount: 37 }), t)
    expect(parts.headline).toBe('rooms.unreadMessages({"count":37})')
  })

  it('passes the raw count to the translator so i18next can pick the plural form', () => {
    const spy = vi.fn((key: string) => key)
    roomTooltipParts(makeRoom({ unreadCount: 1 }), spy)
    expect(spy).toHaveBeenCalledWith('rooms.unreadMessages', { count: 1 })
  })

  it('has no headline when the room is fully read', () => {
    expect(roomTooltipParts(makeRoom({ unreadCount: 0 }), t).headline).toBeNull()
  })

  it('composes occupant count and nickname into the detail line', () => {
    expect(roomTooltipParts(makeRoom({ unreadCount: 37 }), t).detail).toBe('2 rooms.users • me')
  })

  it('drops the nickname segment when the room has no nickname', () => {
    const parts = roomTooltipParts(makeRoom({ nickname: undefined }), t)
    expect(parts.detail).toBe('2 rooms.users')
  })

  it('uses the singular occupant key for a room of one', () => {
    expect(roomTooltipParts(makeRoom({ occupants: occupants(1) }), t).detail).toBe('1 rooms.user • me')
  })

  it('reports joining state with no headline, even with unread messages', () => {
    // isJoining wins over joined — preserves the precedence of the previous
    // getTooltipContent, which checked isJoining first.
    const parts = roomTooltipParts(makeRoom({ isJoining: true, unreadCount: 37 }), t)
    expect(parts).toEqual({ headline: null, detail: 'rooms.joining' })
  })

  it('prompts to join an unjoined room, with no headline', () => {
    const parts = roomTooltipParts(makeRoom({ joined: false, unreadCount: 37 }), t)
    expect(parts).toEqual({ headline: null, detail: 'rooms.doubleClickToJoin' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/utils/roomTooltip.test.ts
```

Expected: FAIL — `Failed to resolve import "./roomTooltip"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/fluux/src/utils/roomTooltip.ts`:

```typescript
import type { Room } from '@fluux/sdk'

// Matches the TranslateFn convention in messagePreviewText.ts / roomJoinError.ts.
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/**
 * The room fields the sidebar row tooltip needs.
 *
 * `mentionsCount` is deliberately absent. The unread headline must not be gated
 * on it — the row's own `@N` badge already carries the mentions number, and a
 * room WITH mentions is exactly the case where the total unread is otherwise
 * invisible. Leaving the field out of the input type makes that gate
 * unrepresentable here.
 */
export type RoomTooltipRoom = Pick<
  Room,
  'joined' | 'isJoining' | 'unreadCount' | 'occupants' | 'nickname'
>

export interface RoomTooltipParts {
  /** "37 unread messages", or null when there is nothing unread to announce. */
  headline: string | null
  /** "12 users • MyNick" | "Joining..." | "Double-click to join" */
  detail: string
}

/**
 * Compose the sidebar room row tooltip.
 *
 * The detail line reproduces the tooltip as it was before the unread headline
 * existed, including the manual singular/plural selection between `rooms.user`
 * and `rooms.users`. The headline is the only new information, and it appears
 * only for a joined room with unread messages.
 */
export function roomTooltipParts(room: RoomTooltipRoom, t: TranslateFn): RoomTooltipParts {
  if (room.isJoining) return { headline: null, detail: t('rooms.joining') }
  if (!room.joined) return { headline: null, detail: t('rooms.doubleClickToJoin') }

  const userCount = room.occupants.size
  const userText = `${userCount} ${userCount === 1 ? t('rooms.user') : t('rooms.users')}`
  const detail = room.nickname ? `${userText} • ${room.nickname}` : userText

  const headline =
    room.unreadCount > 0 ? t('rooms.unreadMessages', { count: room.unreadCount }) : null

  return { headline, detail }
}
```

- [ ] **Step 4: Run tests, typecheck and lint**

```bash
cd apps/fluux && npx vitest run src/utils/roomTooltip.test.ts && npm run typecheck && npm run lint
```

Expected: 8 tests PASS, no stderr, typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/roomTooltip.ts apps/fluux/src/utils/roomTooltip.test.ts
git commit -m "feat(sidebar): add roomTooltipParts helper for the room row tooltip"
```

---

### Task 2: `rooms.unreadMessages` in all 33 locales

**Files:**
- Modify: `apps/fluux/src/i18n/locales/*.json` (all 33)
- Modify: `apps/fluux/src/i18n/i18n.test.ts` (add plural assertions in the `plural forms` describe block)

**Interfaces:**
- Consumes: the key name `rooms.unreadMessages` chosen in Task 1.
- Produces: `rooms.unreadMessages` (+ locale-appropriate plural suffixes) resolvable in every locale. Task 3 depends on nothing further from this task.

- [ ] **Step 1: Write the failing test**

In `apps/fluux/src/i18n/i18n.test.ts`, inside the existing `describe('plural forms for months/years ago', ...)` block, add these tests after the last existing `it(...)`:

```typescript
  it('should use English singular and plural for unread messages', async () => {
    await testI18n.changeLanguage('en')
    expect(testI18n.t('rooms.unreadMessages', { count: 1 })).toBe('1 unread message')
    expect(testI18n.t('rooms.unreadMessages', { count: 37 })).toBe('37 unread messages')
  })

  it('should use French singular and plural for unread messages', async () => {
    await testI18n.changeLanguage('fr')
    expect(testI18n.t('rooms.unreadMessages', { count: 1 })).toBe('1 message non lu')
    expect(testI18n.t('rooms.unreadMessages', { count: 4 })).toBe('4 messages non lus')
  })

  it('should use correct Polish plural forms for unread messages', async () => {
    await testI18n.changeLanguage('pl')
    expect(testI18n.t('rooms.unreadMessages', { count: 1 })).toBe('1 nieprzeczytana wiadomość')
    expect(testI18n.t('rooms.unreadMessages', { count: 3 })).toBe('3 nieprzeczytane wiadomości')
    expect(testI18n.t('rooms.unreadMessages', { count: 12 })).toBe('12 nieprzeczytanych wiadomości')
  })
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/i18n/i18n.test.ts
```

Expected: the three new tests FAIL, each returning the raw key `rooms.unreadMessages` instead of the copy. The parity tests still pass at this point (no key added yet).

- [ ] **Step 3: Add the key to all 33 locales**

Each locale gets the same set of plural suffixes it already uses for `chat.newMessagesCount` — that set was chosen per-language by a translator and is the correct CLDR shape for each.

Run this script from the repository root:

```python
python3 - <<'PY'
import json, pathlib

TRANSLATIONS = {
    'ar': {'_zero': 'لا رسائل غير مقروءة', '': 'رسالة واحدة غير مقروءة', '_two': 'رسالتان غير مقروءتين', '_few': '{{count}} رسائل غير مقروءة', '_many': '{{count}} رسالة غير مقروءة', '_other': '{{count}} رسالة غير مقروءة'},
    'be': {'': '{{count}} непрачытанае паведамленне', '_few': '{{count}} непрачытаныя паведамленні', '_many': '{{count}} непрачытаных паведамленняў', '_other': '{{count}} непрачытанага паведамлення'},
    'bg': {'': '{{count}} непрочетено съобщение', '_other': '{{count}} непрочетени съобщения'},
    'ca': {'': '{{count}} missatge sense llegir', '_many': '{{count}} de missatges sense llegir', '_other': '{{count}} missatges sense llegir'},
    'cs': {'': '{{count}} nepřečtená zpráva', '_few': '{{count}} nepřečtené zprávy', '_many': '{{count}} nepřečtené zprávy', '_other': '{{count}} nepřečtených zpráv'},
    'da': {'': '{{count}} ulæst besked', '_other': '{{count}} ulæste beskeder'},
    'de': {'': '{{count}} ungelesene Nachricht', '_other': '{{count}} ungelesene Nachrichten'},
    'el': {'': '{{count}} μη αναγνωσμένο μήνυμα', '_other': '{{count}} μη αναγνωσμένα μηνύματα'},
    'en': {'': '{{count}} unread message', '_other': '{{count}} unread messages'},
    'es': {'': '{{count}} mensaje sin leer', '_many': '{{count}} de mensajes sin leer', '_other': '{{count}} mensajes sin leer'},
    'et': {'': '{{count}} lugemata sõnum', '_other': '{{count}} lugemata sõnumit'},
    'fi': {'': '{{count}} lukematon viesti', '_other': '{{count}} lukematonta viestiä'},
    'fr': {'': '{{count}} message non lu', '_many': '{{count}} de messages non lus', '_other': '{{count}} messages non lus'},
    'ga': {'': '{{count}} teachtaireacht gan léamh', '_two': '{{count}} theachtaireacht gan léamh', '_few': '{{count}} theachtaireacht gan léamh', '_many': '{{count}} dteachtaireacht gan léamh', '_other': '{{count}} teachtaireacht gan léamh'},
    'he': {'': 'הודעה אחת שלא נקראה', '_two': '2 הודעות שלא נקראו', '_other': '{{count}} הודעות שלא נקראו'},
    'hr': {'': '{{count}} nepročitana poruka', '_few': '{{count}} nepročitane poruke', '_other': '{{count}} nepročitanih poruka'},
    'hu': {'': '{{count}} olvasatlan üzenet', '_other': '{{count}} olvasatlan üzenet'},
    'is': {'': '{{count}} ólesið skilaboð', '_other': '{{count}} ólesin skilaboð'},
    'it': {'': '{{count}} messaggio non letto', '_many': '{{count}} di messaggi non letti', '_other': '{{count}} messaggi non letti'},
    'lt': {'': '{{count}} neperskaitytas pranešimas', '_few': '{{count}} neperskaityti pranešimai', '_many': '{{count}} neperskaityto pranešimo', '_other': '{{count}} neperskaitytų pranešimų'},
    'lv': {'_zero': '{{count}} neizlasītu ziņojumu', '': '{{count}} neizlasīts ziņojums', '_other': '{{count}} neizlasīti ziņojumi'},
    'mt': {'': '{{count}} messaġġ mhux moqri', '_two': '{{count}} messaġġi mhux moqrija', '_few': '{{count}} messaġġi mhux moqrija', '_many': '{{count}} messaġġ mhux moqri', '_other': '{{count}} messaġġ mhux moqri'},
    'nb': {'': '{{count}} ulest melding', '_other': '{{count}} uleste meldinger'},
    'nl': {'': '{{count}} ongelezen bericht', '_other': '{{count}} ongelezen berichten'},
    'pl': {'': '{{count}} nieprzeczytana wiadomość', '_few': '{{count}} nieprzeczytane wiadomości', '_many': '{{count}} nieprzeczytanych wiadomości', '_other': '{{count}} nieprzeczytanej wiadomości'},
    'pt': {'': '{{count}} mensagem não lida', '_many': '{{count}} de mensagens não lidas', '_other': '{{count}} mensagens não lidas'},
    'ro': {'': '{{count}} mesaj necitit', '_few': '{{count}} mesaje necitite', '_other': '{{count}} de mesaje necitite'},
    'ru': {'': '{{count}} непрочитанное сообщение', '_few': '{{count}} непрочитанных сообщения', '_many': '{{count}} непрочитанных сообщений', '_other': '{{count}} непрочитанного сообщения'},
    'sk': {'': '{{count}} neprečítaná správa', '_few': '{{count}} neprečítané správy', '_many': '{{count}} neprečítanej správy', '_other': '{{count}} neprečítaných správ'},
    'sl': {'': '{{count}} neprebrano sporočilo', '_two': '{{count}} neprebrani sporočili', '_few': '{{count}} neprebrana sporočila', '_other': '{{count}} neprebranih sporočil'},
    'sv': {'': '{{count}} oläst meddelande', '_other': '{{count}} olästa meddelanden'},
    'uk': {'': '{{count}} непрочитане повідомлення', '_few': '{{count}} непрочитаних повідомлення', '_many': '{{count}} непрочитаних повідомлень', '_other': '{{count}} непрочитаного повідомлення'},
    'zh-CN': {'': '{{count}} 条未读消息', '_other': '{{count}} 条未读消息'},
}

base = pathlib.Path('apps/fluux/src/i18n/locales')
for lang, forms in TRANSLATIONS.items():
    path = base / f'{lang}.json'
    data = json.loads(path.read_text(encoding='utf-8'))
    for suffix, value in forms.items():
        data['rooms'][f'unreadMessages{suffix}'] = value
    path.write_text(json.dumps(data, ensure_ascii=False, indent=4) + '\n', encoding='utf-8')
    print(f'{lang}: +{len(forms)}')
PY
```

Expected: 33 lines printed, one per locale.

- [ ] **Step 4: Run the i18n suite**

```bash
cd apps/fluux && npx vitest run src/i18n/i18n.test.ts
```

Expected: PASS, including the three new plural tests and every existing parity test (`should have all English keys`, `should not have extra keys beyond English`, `should not have empty translation values`) across all 33 locales.

- [ ] **Step 5: Confirm the diff is confined to the new key**

```bash
git diff --stat apps/fluux/src/i18n/locales
```

Expected: 33 files changed, each with a small insertion count matching its number of plural forms. If any file shows a large rewrite, the JSON round-trip format is wrong — stop and fix before committing.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/i18n
git commit -m "i18n: add rooms.unreadMessages in all locales"
```

---

### Task 3: Render the two-line tooltip in `RoomsList`

**Files:**
- Modify: `apps/fluux/src/components/sidebar-components/RoomsList.tsx` (replace `getTooltipContent` at lines 369-384; the `Tooltip` at line 388; delete the dot `Tooltip` at lines 455-461)
- Test: `apps/fluux/src/components/sidebar-components/RoomsList.tooltip.test.tsx` (create)

**Interfaces:**
- Consumes: `roomTooltipParts`, `RoomTooltipParts` from `@/utils/roomTooltip` (Task 1); `rooms.unreadMessages` (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/sidebar-components/RoomsList.tooltip.test.tsx`. This mirrors the mock setup of the existing `RoomsList.typing.test.tsx`, with one deliberate difference: the `Tooltip` mock renders its `content` prop unconditionally into the DOM. Hover timing is already covered by `Tooltip.test.tsx`; what needs proving here is *what RoomsList passes to Tooltip*.

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Room } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    isMessageFromIgnoredUser: () => false,
    roomActivityTone: () => 'neutral',
    generateConsistentColorHexSync: () => '#123456',
  }
})

const h = vi.hoisted(() => ({ room: null as Room | null }))

vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: (selector: (s: {
    getRoom: (jid: string) => Room | null
    drafts: Map<string, string>
  }) => unknown) => selector({ getRoom: () => h.room, drafts: new Map() }),
  useChatStore: (selector: (s: unknown) => unknown) => selector({}),
  useIgnoreStore: (selector: (s: { ignoredUsers: Record<string, unknown[]> }) => unknown) =>
    selector({ ignoredUsers: {} }),
}))

vi.mock('@/hooks', () => ({
  useContextMenu: () => ({
    isOpen: false,
    longPressTriggered: { current: false },
    handleContextMenu: () => {},
    handleTouchStart: () => {},
    handleTouchEnd: () => {},
    position: { x: 0, y: 0 },
    menuRef: { current: null },
    close: () => {},
  }),
  useListKeyboardNav: () => ({}),
  useRouteSync: () => ({}),
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string; densityMode: string }) => unknown) =>
    selector({ timeFormat: '24h', densityMode: 'comfortable' }),
}))

// Unlike the typing test's mock, this one RENDERS `content`. The assertions are
// about what RoomsList hands to Tooltip; hover/delay behaviour is Tooltip's own
// test's job. Rendering every instance also lets us count them, which is how we
// prove the activity dot no longer carries a tooltip of its own.
vi.mock('../Tooltip', () => ({
  Tooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
    <>
      {children}
      <div data-testid="tooltip-content">{content}</div>
    </>
  ),
}))

// Import AFTER mocks so RoomItem picks them up.
import { RoomItem } from './RoomsList'

const makeRoom = (over: Partial<Room> = {}): Room =>
  ({
    jid: 'team@conference.fluux.chat',
    name: 'Team',
    joined: true,
    isJoining: false,
    nickname: 'me',
    nickToJidCache: new Map(),
    occupants: new Map([['alice', {}], ['bob', {}]]),
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set<string>(),
    lastMessage: null,
    avatar: undefined,
    subject: undefined,
    autojoin: false,
    isBookmarked: false,
    ...over,
  }) as unknown as Room

const noop = () => {}
const renderRoom = (room: Room) => {
  h.room = room
  return render(
    <RoomItem
      roomJid={room.jid}
      isActive={false}
      isSelected={false}
      isKeyboardNav={false}
      onSelect={noop}
      onActivate={noop}
      onJoin={noop}
      onLeave={noop}
      onEditBookmark={noop}
      onRemoveBookmark={noop}
      onToggleAutojoin={noop}
    />,
  )
}

describe('RoomItem tooltip', () => {
  it('puts the unread headline above the occupant detail line', () => {
    renderRoom(makeRoom({ unreadCount: 37 }))
    const tooltip = screen.getByTestId('tooltip-content')
    // t is mocked to echo the key, so the headline renders as the bare key.
    expect(tooltip.textContent).toContain('rooms.unreadMessages')
    expect(tooltip.textContent).toContain('2 rooms.users • me')
  })

  it('still shows the unread headline when the room also has mentions', () => {
    // The regression this feature exists to prevent: the old activity-dot
    // tooltip was gated on mentionsCount === 0, which hid the total unread
    // exactly when the room was busiest. Only a render test can catch a
    // reintroduced gate — roomTooltipParts cannot even see mentionsCount.
    renderRoom(makeRoom({ unreadCount: 37, mentionsCount: 3 }))
    expect(screen.getByTestId('tooltip-content').textContent).toContain('rooms.unreadMessages')
  })

  it('shows only the detail line when the room is fully read', () => {
    renderRoom(makeRoom({ unreadCount: 0 }))
    const tooltip = screen.getByTestId('tooltip-content')
    expect(tooltip.textContent).not.toContain('rooms.unreadMessages')
    expect(tooltip.textContent).toContain('2 rooms.users • me')
  })

  it('gives the activity dot no tooltip of its own', () => {
    // A room with unread and no mentions is precisely the state that used to
    // render a second, nested Tooltip around the dot.
    renderRoom(makeRoom({ unreadCount: 37, mentionsCount: 0 }))
    expect(screen.getAllByTestId('tooltip-content')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/components/sidebar-components/RoomsList.tooltip.test.tsx
```

Expected: FAIL. The first three tests fail because the tooltip text is the old single-line string with no `rooms.unreadMessages`; the last fails with `expected length 1, received 2` because the dot still has its own `Tooltip`.

- [ ] **Step 3: Import the helper**

In `apps/fluux/src/components/sidebar-components/RoomsList.tsx`, add the import next to the other `@/utils` imports (after the `import { visibleRoomTypingNicks } from '@/utils/roomTyping'` line):

```typescript
import { roomTooltipParts } from '@/utils/roomTooltip'
```

- [ ] **Step 4: Replace `getTooltipContent` with the helper**

Replace this block (`RoomsList.tsx`, lines 369-384):

```typescript
  // Determine tooltip based on state
  const getTooltipContent = () => {
    if (room.isJoining) return t('rooms.joining')
    if (room.joined) {
      // Show user count and nickname in tooltip for joined rooms
      const userCount = room.occupants.size
      const userText = `${userCount} ${userCount === 1 ? t('rooms.user') : t('rooms.users')}`
      if (room.nickname) {
        return `${userText} • ${room.nickname}`
      }
      return userText
    }
    return t('rooms.doubleClickToJoin')
  }

  const tooltipContent = getTooltipContent()
```

with:

```typescript
  // Tooltip: the unread count as a headline (the row itself only shows a dot,
  // so this is the one place the number is legible), over the occupant/nickname
  // detail line. With nothing unread this stays a bare string — byte-identical
  // to the pre-headline tooltip.
  const { headline, detail } = roomTooltipParts(room, t)
  const tooltipContent = headline ? (
    <div>
      <div className="font-medium">{headline}</div>
      <div className="text-xs text-fluux-muted">{detail}</div>
    </div>
  ) : (
    detail
  )
```

- [ ] **Step 5: Remove the activity dot's nested tooltip**

Replace this block (`RoomsList.tsx`, lines 451-462):

```tsx
            {/* Activity dot for unread (non-mention) activity. Red for a
                notify-all room — the attention tier, matching the icon-rail
                indicator and mention badge — grey for plain unread. */}
            {room.joined && room.unreadCount > 0 && room.mentionsCount === 0 && (
              <Tooltip content={`${room.unreadCount} unread`} position="top">
                <div
                  className={`size-2.5 rounded-full flex-shrink-0 ${
                    roomActivityTone(room) === 'accent' ? 'bg-fluux-badge-strong' : 'bg-fluux-gray'
                  }`}
                />
              </Tooltip>
            )}
```

with:

```tsx
            {/* Activity dot for unread (non-mention) activity. Red for a
                notify-all room — the attention tier, matching the icon-rail
                indicator and mention badge — grey for plain unread. The count
                itself lives in the row tooltip; the dot carries no tooltip of
                its own (nested inside the row's, it popped a second bubble). */}
            {room.joined && room.unreadCount > 0 && room.mentionsCount === 0 && (
              <div
                className={`size-2.5 rounded-full flex-shrink-0 ${
                  roomActivityTone(room) === 'accent' ? 'bg-fluux-badge-strong' : 'bg-fluux-gray'
                }`}
              />
            )}
```

- [ ] **Step 6: Run the new test**

```bash
cd apps/fluux && npx vitest run src/components/sidebar-components/RoomsList.tooltip.test.tsx
```

Expected: 4 tests PASS.

- [ ] **Step 7: Run the affected suite, typecheck and lint**

```bash
scripts/test-affected.sh apps/fluux/src/components/sidebar-components/RoomsList.tsx apps/fluux/src/utils/roomTooltip.ts
```

Then:

```bash
npm run typecheck && npm run lint
```

Expected: all selected tests PASS with no stderr — in particular the existing `RoomsList.typing.test.tsx` must stay green. Typecheck and lint clean.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/RoomsList.tsx apps/fluux/src/components/sidebar-components/RoomsList.tooltip.test.tsx
git commit -m "feat(sidebar): show the unread count in the room row tooltip"
```

---

### Task 4: Verify in the running app

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: PASS across both workspaces, no stderr.

- [ ] **Step 2: Launch demo mode**

```bash
npm run dev
```

Open `http://localhost:5173/demo.html?tutorial=false`, go to the Rooms view.

- [ ] **Step 3: Check the three states by hover**

- A room with unread and no mentions → two-line tooltip, headline `N unread messages`, detail `N users • nick`. Hovering the grey/red dot itself must show **one** bubble, not two.
- A room with mentions (`@N` badge on the row) → the tooltip still shows the unread headline.
- A fully-read room → single-line tooltip, unchanged from before.

- [ ] **Step 4: Check a non-English locale**

Switch the language to French in Settings → and re-hover a room with unread messages. Expected: `4 messages non lus`, and `1 message non lu` for a single unread — no raw `rooms.unreadMessages` key on screen.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Two-line tooltip, headline + detail | 3 (steps 4) |
| Headline only when `joined && unreadCount > 0` | 1 |
| Headline shows even with mentions | 1 (type excludes `mentionsCount`), 3 (render test) |
| Joining / not-joined unchanged | 1 |
| Detail keeps manual `rooms.user`/`rooms.users` plural | 1 |
| Dot tooltip deleted | 3 (step 5) |
| No tint on the headline | 3 (step 4 — `font-medium` / `text-xs text-fluux-muted` only) |
| Pure module in `utils/`, narrow `Pick<>` | 1 |
| Bare string passed to `Tooltip` when headline is null | 3 (step 4) |
| `unreadMessages` + `_other`, `chat.newMessagesCount` convention | 2 |
| All 33 locales | 2 |
| Pure-function unit tests | 1 |
| Render test proving the wiring | 3 |

The spec's `test-setup.ts` note does not apply: both new test files mock `react-i18next` locally (following `RoomsList.typing.test.tsx`), so the shared i18n subset is never consulted. Real copy is asserted in `i18n.test.ts` against the actual locale files instead, which is stronger.

**Placeholder scan:** none — every step carries the literal code, the literal translation table, and an exact command with expected output.

**Type consistency:** `roomTooltipParts` / `RoomTooltipRoom` / `RoomTooltipParts` and the `{ headline, detail }` shape are used identically in Tasks 1 and 3. The key `rooms.unreadMessages` is spelled the same in Tasks 1, 2 and 3.
