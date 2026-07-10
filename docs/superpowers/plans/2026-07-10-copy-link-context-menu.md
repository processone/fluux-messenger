# Copy-link Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users copy (and open) a website link from a chat message — via right-click on desktop and via the touch action sheet on mobile.

**Architecture:** A shared `MessageLink` component replaces the raw `<a>` at both link render sites and owns a right-click-only `useContextMenu` that shows a `LinkContextMenu` popover (Copy link / Open in browser), mirroring the existing `ImageContextMenu`. On touch, the message bubble's existing `MessageActionSheet` grows a *Copy link* row (with a chooser when a message holds several links). A duplicated `openInBrowser` helper is extracted to a shared util.

**Tech Stack:** React 19, TypeScript, Tailwind, Vitest + Testing Library, react-i18next, Tauri (`@tauri-apps/plugin-shell`).

## Global Constraints

- SDK/app split: this is all in `apps/fluux` — no SDK changes.
- i18n: every new key added to **all 33 locales** in `apps/fluux/src/i18n/locales/` with real translations (no English placeholders); **no em-dash connectors**; surgical edits (parse → mutate → `JSON.stringify(obj, null, 4) + "\n"`, never reformat the whole file).
- Never include a Claude footer in commit messages.
- App tests run under happy-dom; DOM/interaction tests that need a real layout pin `// @vitest-environment jsdom` at the top of the file.
- Run app tests per-workspace: `cd apps/fluux && npx vitest run <path>` (never bare root `vitest`).
- Reuse existing building blocks: `MenuButton` (`apps/fluux/src/components/sidebar-components/SidebarListMenu.tsx`), `copyToClipboard` (`apps/fluux/src/utils/clipboard.ts`), `useContextMenu` (`apps/fluux/src/hooks/useContextMenu.ts`), `useFocusTrap` (`apps/fluux/src/hooks/useFocusTrap.ts`), `fluux-popover` styling.

---

## File Structure

- Create `apps/fluux/src/utils/openInBrowser.ts` — Tauri/web "open URL externally" helper (extracted from `ImageContextMenu`).
- Create `apps/fluux/src/components/LinkContextMenu.tsx` — right-click popover for a single link.
- Create `apps/fluux/src/components/conversation/MessageLink.tsx` — `<a>` wrapper that owns the right-click menu.
- Modify `apps/fluux/src/components/ImageContextMenu.tsx` — use the shared `openInBrowser`.
- Modify `apps/fluux/src/utils/messageStyles.tsx` — add `extractLinks`; route both `<a>` sites through `MessageLink`.
- Modify `apps/fluux/src/components/conversation/MessageActionSheet.tsx` — add *Copy link* row + chooser.
- Modify all 33 `apps/fluux/src/i18n/locales/*.json` — add `chat.copyLink`, `chat.copyLinkChoose`.
- Modify `apps/fluux/src/test-setup.ts` — add the two new keys to the `chat` i18n subset.
- Tests: `openInBrowser.test.ts`, `LinkContextMenu.test.tsx`, `MessageLink.test.tsx`, `messageStyles` extractLinks test, `MessageActionSheet.test.tsx`.

---

## Task 1: i18n keys

**Files:**
- Modify: `apps/fluux/src/i18n/locales/en.json` (after line 491, `"copyImageUrl"`)
- Modify: all other 32 files in `apps/fluux/src/i18n/locales/*.json`
- Modify: `apps/fluux/src/test-setup.ts:102` (`chat` block)

**Interfaces:**
- Produces: i18n keys `chat.copyLink`, `chat.copyLinkChoose` in every locale and in the test i18n subset.

- [ ] **Step 1: Add keys to `en.json`**

Insert into the `chat` object, right after `"copyImageUrl": "Copy image URL",` (line 491):

```json
        "copyLink": "Copy link",
        "copyLinkChoose": "Copy which link?",
```

- [ ] **Step 2: Add keys to the remaining 32 locales**

For each other `apps/fluux/src/i18n/locales/<lang>.json`, add `copyLink` and `copyLinkChoose` inside its `chat` object with real translations for that language (translate yourself; no English placeholders; no em-dash). Use surgical edits — parse the file, add the two keys, re-serialize with `JSON.stringify(obj, null, 4) + "\n"`.

- [ ] **Step 3: Add keys to the test i18n subset**

In `apps/fluux/src/test-setup.ts`, extend the `chat` block (line 102) so asserted labels resolve:

```ts
        chat: {
          typing: {
            one: '{{name}} is typing...',
            two: '{{name1}} and {{name2}} are typing...',
            three: '{{name1}}, {{name2}}, and {{name3}} are typing...',
            many: '{{name1}}, {{name2}}, and {{count}} others are typing...',
          },
          newMessagesCount: '{{count}} new message',
          newMessagesCount_other: '{{count}} new messages',
          youWereAway: 'You were away',
          copyLink: 'Copy link',
          copyLinkChoose: 'Copy which link?',
          openInBrowser: 'Open in browser',
          copyMessage: 'Copy text',
        },
```

- [ ] **Step 4: Verify all locales parse and contain the keys**

Run: `cd apps/fluux && node -e "const fs=require('fs');const d='src/i18n/locales';let bad=[];for(const f of fs.readdirSync(d)){if(!f.endsWith('.json'))continue;const o=JSON.parse(fs.readFileSync(d+'/'+f));if(!o.chat||!o.chat.copyLink||!o.chat.copyLinkChoose)bad.push(f);}console.log(bad.length?('MISSING: '+bad.join(', ')):'OK all 33');"`
Expected: `OK all 33`

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/i18n/locales apps/fluux/src/test-setup.ts
git commit -m "i18n(chat): add copyLink / copyLinkChoose keys (#908)"
```

---

## Task 2: Shared `openInBrowser` util

**Files:**
- Create: `apps/fluux/src/utils/openInBrowser.ts`
- Test: `apps/fluux/src/utils/openInBrowser.test.ts`
- Modify: `apps/fluux/src/components/ImageContextMenu.tsx:17-24` (remove local copy, import shared)

**Interfaces:**
- Produces: `export async function openInBrowser(url: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/utils/openInBrowser.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const openMock = vi.fn()
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openMock }))

describe('openInBrowser', () => {
  beforeEach(() => {
    vi.resetModules()
    openMock.mockReset()
  })

  it('uses window.open on web', async () => {
    vi.doMock('./tauri', () => ({ isTauri: () => false }))
    const winOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { openInBrowser } = await import('./openInBrowser')
    await openInBrowser('https://example.com')
    expect(winOpen).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    expect(openMock).not.toHaveBeenCalled()
  })

  it('uses the Tauri shell open on desktop', async () => {
    vi.doMock('./tauri', () => ({ isTauri: () => true }))
    const { openInBrowser } = await import('./openInBrowser')
    await openInBrowser('https://example.com')
    expect(openMock).toHaveBeenCalledWith('https://example.com')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/openInBrowser.test.ts`
Expected: FAIL — cannot resolve `./openInBrowser`.

- [ ] **Step 3: Write the util**

Create `apps/fluux/src/utils/openInBrowser.ts`:

```ts
import { isTauri } from './tauri'

/**
 * Open a URL in the user's default browser.
 *
 * On the Tauri desktop app this hands off to the OS via the shell plugin so the
 * link opens in the real browser (not a new WebView window). On web/PWA it falls
 * back to `window.open` with `noopener,noreferrer`.
 */
export async function openInBrowser(url: string): Promise<void> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/openInBrowser.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Refactor `ImageContextMenu` to use it**

In `apps/fluux/src/components/ImageContextMenu.tsx`, delete the local `openInBrowser` function (lines 17-24) and its now-unused `isTauri` import, and add:

```ts
import { openInBrowser } from '@/utils/openInBrowser'
```

Leave the rest (the `handleOpenInBrowser` caller) unchanged.

- [ ] **Step 6: Verify ImageContextMenu still typechecks and no dead imports**

Run: `cd apps/fluux && npx vitest run src/utils/openInBrowser.test.ts && npx tsc --noEmit -p .`
Expected: tests PASS; tsc reports no errors (in particular no "isTauri declared but never used").

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/utils/openInBrowser.ts apps/fluux/src/utils/openInBrowser.test.ts apps/fluux/src/components/ImageContextMenu.tsx
git commit -m "refactor(links): extract shared openInBrowser util (#908)"
```

---

## Task 3: `extractLinks` helper

**Files:**
- Modify: `apps/fluux/src/utils/messageStyles.tsx` (add exported function near `URL_REGEX`, line 28)
- Test: `apps/fluux/src/utils/messageStyles.extractLinks.test.ts`

**Interfaces:**
- Consumes: existing `URL_REGEX` in `messageStyles.tsx:28`.
- Produces: `export function extractLinks(text: string): string[]` — links in document order, de-duplicated.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/utils/messageStyles.extractLinks.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractLinks } from './messageStyles'

describe('extractLinks', () => {
  it('returns [] when there are no links', () => {
    expect(extractLinks('just some text')).toEqual([])
  })

  it('extracts a single link', () => {
    expect(extractLinks('see https://example.com now')).toEqual(['https://example.com'])
  })

  it('extracts multiple links in document order', () => {
    expect(extractLinks('a https://a.com b https://b.com')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })

  it('de-duplicates identical links', () => {
    expect(extractLinks('https://a.com and again https://a.com')).toEqual(['https://a.com'])
  })

  it('strips trailing sentence punctuation', () => {
    expect(extractLinks('go to https://example.com.')).toEqual(['https://example.com'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/messageStyles.extractLinks.test.ts`
Expected: FAIL — `extractLinks` is not exported.

- [ ] **Step 3: Implement the helper**

In `apps/fluux/src/utils/messageStyles.tsx`, immediately after the `URL_REGEX` definition (line 28), add:

```ts
/**
 * Return every http(s) URL found in `text`, in document order, de-duplicated.
 * Shares URL_REGEX with the message renderer so "what is a link" stays consistent
 * between the rendered text and the copy-link affordances.
 */
export function extractLinks(text: string): string[] {
  if (!text) return []
  URL_REGEX.lastIndex = 0
  const seen = new Set<string>()
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = URL_REGEX.exec(text)) !== null) {
    const url = match[0]
    if (!seen.has(url)) {
      seen.add(url)
      out.push(url)
    }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/messageStyles.extractLinks.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/messageStyles.tsx apps/fluux/src/utils/messageStyles.extractLinks.test.ts
git commit -m "feat(links): add extractLinks helper (#908)"
```

---

## Task 4: `LinkContextMenu` component

**Files:**
- Create: `apps/fluux/src/components/LinkContextMenu.tsx`
- Test: `apps/fluux/src/components/LinkContextMenu.test.tsx`

**Interfaces:**
- Consumes: `openInBrowser` (Task 2); `copyToClipboard`; `MenuButton`; `useFocusTrap`; `ContextMenuState` from `useContextMenu`.
- Produces: `export function LinkContextMenu(props: { url: string; menu: ContextMenuState }): JSX.Element | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/LinkContextMenu.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createRef } from 'react'
import { LinkContextMenu } from './LinkContextMenu'
import type { ContextMenuState } from '@/hooks/useContextMenu'

const copyMock = vi.fn()
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: (t: string) => copyMock(t) }))
const openMock = vi.fn()
vi.mock('@/utils/openInBrowser', () => ({ openInBrowser: (u: string) => openMock(u) }))

function makeMenu(isOpen: boolean): ContextMenuState {
  return {
    isOpen,
    position: { x: 10, y: 20 },
    menuRef: createRef<HTMLDivElement>(),
    longPressTriggered: createRef<boolean>() as ContextMenuState['longPressTriggered'],
    close: vi.fn(),
    handleContextMenu: vi.fn(),
    handleTouchStart: vi.fn(),
    handleTouchEnd: vi.fn(),
  }
}

describe('LinkContextMenu', () => {
  beforeEach(() => {
    copyMock.mockReset()
    openMock.mockReset()
  })

  it('renders nothing when closed', () => {
    const { container } = render(<LinkContextMenu url="https://x.com" menu={makeMenu(false)} />)
    expect(container.firstChild).toBeNull()
  })

  it('copies the link', () => {
    render(<LinkContextMenu url="https://x.com" menu={makeMenu(true)} />)
    fireEvent.click(screen.getByText('Copy link'))
    expect(copyMock).toHaveBeenCalledWith('https://x.com')
  })

  it('opens the link in the browser', () => {
    render(<LinkContextMenu url="https://x.com" menu={makeMenu(true)} />)
    fireEvent.click(screen.getByText('Open in browser'))
    expect(openMock).toHaveBeenCalledWith('https://x.com')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/LinkContextMenu.test.tsx`
Expected: FAIL — cannot resolve `./LinkContextMenu`.

- [ ] **Step 3: Write the component**

Create `apps/fluux/src/components/LinkContextMenu.tsx`:

```tsx
import { useTranslation } from 'react-i18next'
import { Copy, ExternalLink } from 'lucide-react'
import { MenuButton } from './sidebar-components/SidebarListMenu'
import { copyToClipboard } from '@/utils/clipboard'
import { openInBrowser } from '@/utils/openInBrowser'
import type { ContextMenuState } from '@/hooks/useContextMenu'
import { useFocusTrap } from '@/hooks/useFocusTrap'

interface LinkContextMenuProps {
  url: string
  menu: ContextMenuState
}

/**
 * Right-click / long-press menu for a hyperlink in a message. Mirrors
 * ImageContextMenu: a small popover positioned at the click point with
 * "Copy link" and "Open in browser". Rendered by MessageLink.
 */
export function LinkContextMenu({ url, menu }: LinkContextMenuProps) {
  const { t } = useTranslation()
  useFocusTrap(menu.menuRef, { active: menu.isOpen })

  if (!menu.isOpen) return null

  const handleCopy = () => {
    menu.close()
    void copyToClipboard(url)
  }

  const handleOpen = () => {
    menu.close()
    void openInBrowser(url)
  }

  return (
    <div
      ref={menu.menuRef}
      className="fixed z-50 min-w-[180px] py-1 rounded-lg fluux-popover"
      style={{ left: menu.position.x, top: menu.position.y }}
    >
      <MenuButton onClick={handleCopy} icon={<Copy className="size-4" />} label={t('chat.copyLink')} />
      <MenuButton
        onClick={handleOpen}
        icon={<ExternalLink className="size-4" />}
        label={t('chat.openInBrowser')}
      />
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/LinkContextMenu.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/LinkContextMenu.tsx apps/fluux/src/components/LinkContextMenu.test.tsx
git commit -m "feat(links): add LinkContextMenu popover (#908)"
```

---

## Task 5: `MessageLink` component + wire both render sites

**Files:**
- Create: `apps/fluux/src/components/conversation/MessageLink.tsx`
- Test: `apps/fluux/src/components/conversation/MessageLink.test.tsx`
- Modify: `apps/fluux/src/utils/messageStyles.tsx:298-309` (link case in `renderSegment`)
- Modify: `apps/fluux/src/utils/messageStyles.tsx:629-639` (`renderTextWithLinks`)

**Interfaces:**
- Consumes: `useContextMenu`; `LinkContextMenu` (Task 4); `createPortal`.
- Produces: `export function MessageLink(props: { href: string; children?: React.ReactNode; className?: string }): JSX.Element`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/conversation/MessageLink.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageLink } from './MessageLink'

describe('MessageLink', () => {
  it('renders an anchor to the href', () => {
    render(<MessageLink href="https://example.com" />)
    const a = screen.getByRole('link', { name: 'https://example.com' })
    expect(a).toHaveAttribute('href', 'https://example.com')
    expect(a).toHaveAttribute('target', '_blank')
  })

  it('opens the context menu on right-click', () => {
    render(<MessageLink href="https://example.com" />)
    // menu is closed initially
    expect(screen.queryByText('Copy link')).toBeNull()
    fireEvent.contextMenu(screen.getByRole('link'))
    expect(screen.getByText('Copy link')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageLink.test.tsx`
Expected: FAIL — cannot resolve `./MessageLink`.

- [ ] **Step 3: Write the component**

Create `apps/fluux/src/components/conversation/MessageLink.tsx`:

```tsx
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useContextMenu } from '@/hooks/useContextMenu'
import { LinkContextMenu } from '../LinkContextMenu'

interface MessageLinkProps {
  href: string
  children?: ReactNode
  className?: string
}

/**
 * A hyperlink inside a message. Left-click follows the link (handled globally by
 * externalLinkHandler); right-click opens LinkContextMenu (Copy link / Open in
 * browser) so the URL can be copied even on packaged desktop builds where the
 * native WebView menu is suppressed.
 *
 * Touch long-press is intentionally NOT wired here: the message bubble already
 * owns a long-press that opens MessageActionSheet, which carries its own Copy-link
 * affordance. The menu is portalled to document.body so its `position: fixed`
 * isn't offset by the virtualizer's row transforms.
 */
export function MessageLink({ href, children, className = 'text-fluux-link hover:underline' }: MessageLinkProps) {
  const menu = useContextMenu()
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        onContextMenu={menu.handleContextMenu}
      >
        {children ?? href}
      </a>
      {menu.isOpen && createPortal(<LinkContextMenu url={href} menu={menu} />, document.body)}
    </>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageLink.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire `renderSegment` (message body)**

In `apps/fluux/src/utils/messageStyles.tsx`, add the import near the top (after the existing local imports, e.g. below line 25):

```ts
import { MessageLink } from '../components/conversation/MessageLink'
```

Replace the `case 'link'` block (lines 298-309) with:

```tsx
    case 'link':
      return <MessageLink key={index} href={segment.content} />
```

- [ ] **Step 6: Wire `renderTextWithLinks` (room subjects)**

In the same file, replace the `<a>` pushed inside `renderTextWithLinks` (lines 629-639) with:

```tsx
    parts.push(<MessageLink key={match.index} href={url} />)
```

- [ ] **Step 7: Run the messageStyles tests to confirm no regressions**

Run: `cd apps/fluux && npx vitest run src/utils/messageStyles.test.tsx src/components/conversation/MessageLink.test.tsx`
Expected: PASS. (If a snapshot in `messageStyles.test.tsx` captured the old `<a>` markup, update it with `-u` after confirming the new output renders the link text and href.)

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageLink.tsx apps/fluux/src/components/conversation/MessageLink.test.tsx apps/fluux/src/utils/messageStyles.tsx apps/fluux/src/utils/__snapshots__ 2>/dev/null; git commit -m "feat(links): right-click copy/open via MessageLink (#908)"
```

---

## Task 6: `MessageActionSheet` Copy-link row + chooser

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageActionSheet.tsx`
- Test: `apps/fluux/src/components/conversation/MessageActionSheet.test.tsx`

**Interfaces:**
- Consumes: `extractLinks` (Task 3); `copyToClipboard`; existing `body` prop.
- Produces: no new public API — internal *Copy link* row and chooser view.

- [ ] **Step 1: Write the failing tests**

Add to `apps/fluux/src/components/conversation/MessageActionSheet.test.tsx` (create if missing; keep any existing cases). Full file if creating:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageActionSheet } from './MessageActionSheet'

const copyMock = vi.fn()
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: (t: string) => copyMock(t) }))

const baseProps = {
  open: true,
  onClose: vi.fn(),
  myReactions: [],
  onReply: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  canReply: false,
  canEdit: false,
  canDelete: false,
}

describe('MessageActionSheet copy-link', () => {
  beforeEach(() => copyMock.mockReset())

  it('hides Copy link when the body has no links', () => {
    render(<MessageActionSheet {...baseProps} body="no links here" />)
    expect(screen.queryByText('Copy link')).toBeNull()
  })

  it('copies the only link directly', () => {
    render(<MessageActionSheet {...baseProps} body="visit https://a.com today" />)
    fireEvent.click(screen.getByText('Copy link'))
    expect(copyMock).toHaveBeenCalledWith('https://a.com')
  })

  it('opens a chooser when there are several links', () => {
    render(<MessageActionSheet {...baseProps} body="https://a.com and https://b.com" />)
    fireEvent.click(screen.getByText('Copy link'))
    // chooser header appears; both URLs are listed
    expect(screen.getByText('Copy which link?')).toBeInTheDocument()
    fireEvent.click(screen.getByText('https://b.com'))
    expect(copyMock).toHaveBeenCalledWith('https://b.com')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageActionSheet.test.tsx`
Expected: FAIL — no "Copy link" element.

- [ ] **Step 3: Implement the row + chooser**

In `apps/fluux/src/components/conversation/MessageActionSheet.tsx`:

Add imports (extend the existing lucide import and add the helpers):

```ts
import { Reply, Pencil, Trash2, Copy, SmilePlus, Link2 } from 'lucide-react'
import { extractLinks } from '../../utils/messageStyles'
import { copyToClipboard } from '@/utils/clipboard'
```

Add a chooser state next to `showEmojiPicker` (line 52):

```ts
  const [showLinkPicker, setShowLinkPicker] = useState(false)
```

Extend `close()` (line 55) to also reset the link picker:

```ts
  const close = () => {
    setShowEmojiPicker(false)
    setShowLinkPicker(false)
    onClose()
  }
```

Derive links and a copy handler (near `canCopy`, line 75):

```ts
  const links = extractLinks(body ?? '')
  const copyLink = (url: string) => {
    void copyToClipboard(url)
    close()
  }
  const onCopyLinkClick = () => {
    if (links.length === 1) copyLink(links[0])
    else setShowLinkPicker(true)
  }
```

Render the chooser as a third branch of the top-level conditional. Change the opening of the render conditional (line 79) from `{showEmojiPicker ? (...) : (...)}` to a nested form so the link picker takes priority when active:

```tsx
      {showLinkPicker ? (
        <div className="pb-1">
          <div className="px-3 py-2 text-sm text-fluux-muted">{t('chat.copyLinkChoose')}</div>
          {links.map((url) => (
            <MenuButton
              key={url}
              onClick={() => copyLink(url)}
              icon={<Link2 className="size-5 shrink-0" />}
              label={url}
              className="py-3 [&_span]:min-w-0 [&_span]:truncate"
            />
          ))}
        </div>
      ) : showEmojiPicker ? (
```

(The existing `showEmojiPicker` branch and its `: (` else-branch stay as-is after this.)

Add the *Copy link* row inside the action rows block, immediately after the `canCopy` (Copy text) `MenuButton` (after line 132):

```tsx
            {links.length > 0 && (
              <MenuButton
                onClick={onCopyLinkClick}
                icon={<Link2 className="size-5" />}
                label={t('chat.copyLink')}
                className="py-3"
              />
            )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageActionSheet.test.tsx`
Expected: PASS (3 new tests + any pre-existing).

- [ ] **Step 5: Full typecheck + affected tests**

Run: `cd apps/fluux && npx tsc --noEmit -p . && npx vitest run src/components/conversation/MessageActionSheet.test.tsx src/components/conversation/MessageLink.test.tsx src/components/LinkContextMenu.test.tsx src/utils/messageStyles.extractLinks.test.ts src/utils/openInBrowser.test.ts`
Expected: tsc clean; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageActionSheet.tsx apps/fluux/src/components/conversation/MessageActionSheet.test.tsx
git commit -m "feat(links): copy-link row + chooser in message action sheet (#908)"
```

---

## Final verification

- [ ] **Run the app test suite + typecheck + lint**

Run: `cd apps/fluux && npx tsc --noEmit -p . && npx eslint src/components/LinkContextMenu.tsx src/components/conversation/MessageLink.tsx src/components/conversation/MessageActionSheet.tsx src/utils/openInBrowser.ts src/utils/messageStyles.tsx && npx vitest run`
Expected: clean typecheck, no lint errors, green suite (no unrelated failures introduced).

- [ ] **Manual smoke (desktop):** In `npm run dev` demo mode, send/open a message with a link, right-click the link → *Copy link* / *Open in browser* appear and work. (Note: `tauri:dev` keeps the native menu, so the app menu is verified on web; packaged-build suppression is the same code path.)
- [ ] **Manual smoke (touch):** Resize to mobile, long-press a message bubble with one link → *Copy link* copies it; with two links → chooser lists both.
