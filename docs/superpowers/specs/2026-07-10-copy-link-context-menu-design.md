# Copy a link from a chat message — design

Issue: [#908](https://github.com/processone/fluux-messenger/issues/908) — "Right-click to copy website link not working in chat message"

## Problem

On **packaged desktop (Tauri) builds**, right-clicking a link inside a chat message
does nothing. `useNativeContextMenuSuppression`
(`apps/fluux/src/hooks/useNativeContextMenuSuppression.ts`) globally swallows the
WebView's native context menu (to hide "Reload / Inspect Element / Save Image As…")
everywhere except editable fields and active text selections. Message-body links are
rendered as plain `<a href target="_blank">` with no context-menu handling of their
own, so on desktop there is neither a native nor an app menu — right-click is a no-op.

On web/PWA and `tauri:dev` the native menu still works, which is why the bug only
reproduces in the packaged app.

There is an existing precedent for the fix: `apps/fluux/src/components/ImageContextMenu.tsx`
gives images a custom app-level menu (Copy URL / Open in browser / Save).

## Approach

Provide a **custom app-level menu** for links (Option B), applied on **all builds**
(consistent with how `ImageContextMenu` already overrides the native menu on images).
Actions: **Copy link** and **Open in browser**.

Two surfaces, matched to each platform's input:

| Platform | Trigger | UI |
|---|---|---|
| Desktop | Right-click **on the link itself** | `LinkContextMenu` popover — *Copy link*, *Open in browser* |
| Touch | Long-press the **bubble** → existing action sheet | New *Copy link* row; if >1 link, a second in-sheet chooser |

This split deliberately resolves a mobile interaction conflict: the message bubble
already owns a long-press handler that opens `MessageActionSheet`
(`apps/fluux/src/components/conversation/MessageBubble.tsx`). A link that also handled
long-press would fire two menus at once. So the link wires **only right-click**; the
bubble's action sheet remains the single mobile surface and simply grows a *Copy link*
entry.

## Coverage

Both link render sites route through the new shared component:
- Message bodies — `apps/fluux/src/utils/messageStyles.tsx:298` (`renderSegment`).
- Room subjects / headers — `apps/fluux/src/utils/messageStyles.tsx:630`
  (`renderTextWithLinks`).

## Components

### 1. `extractLinks(text): string[]`
New exported helper in `messageStyles.tsx`. Reuses the existing `URL_REGEX`
(`messageStyles.tsx:28`), returns links in document order, de-duplicated. Single source
of truth for "what links are in this body," consumed by `MessageActionSheet`.
Must reset `URL_REGEX.lastIndex` before iterating (the regex is `/g`).

### 2. `openInBrowser(url): Promise<void>`
Extract the helper currently **duplicated** inside `ImageContextMenu.tsx` (lines 17–24)
into `apps/fluux/src/utils/openInBrowser.ts`:
- Tauri: dynamic `import('@tauri-apps/plugin-shell')` → `open(url)`.
- Web: `window.open(url, '_blank', 'noopener,noreferrer')`.

`ImageContextMenu` and the new `LinkContextMenu` both import it. (CLAUDE.md: avoid
duplicate code.)

### 3. `LinkContextMenu.tsx`
New component modeled on `ImageContextMenu`. Props: `url: string` and
`menu: ContextMenuState`. Renders:
- **Copy link** → `copyToClipboard(url)` (`@/utils/clipboard`).
- **Open in browser** → `openInBrowser(url)`.

Reuses `MenuButton` (`./sidebar-components/SidebarListMenu`), the `fluux-popover`
styling, and `useFocusTrap`. Returns `null` when `!menu.isOpen`.

### 4. `MessageLink.tsx`
New component that replaces the raw `<a>` at both render sites. Props: `href: string`,
`children: React.ReactNode` (defaults to the URL text), plus the existing className /
`target="_blank"` / `rel="noopener noreferrer"`.

- Owns one `useContextMenu()` instance.
- Wires **only `onContextMenu={menu.handleContextMenu}`** — no `onTouchStart`/
  `onTouchEnd` (touch is intentionally left to the bubble action sheet).
- Renders `<LinkContextMenu url={href} menu={menu} />` via `createPortal` to
  `document.body`. Portal is required so the menu's `position: fixed` is not offset by
  the virtualizer's row `transform` (a fixed element inside a transformed ancestor is
  positioned relative to that ancestor). `messageStyles.tsx` already imports
  `createPortal`.

### 5. `MessageActionSheet.tsx`
Derive `links = extractLinks(body)` internally (no new prop; `body` is already passed).
Add a **Copy link** `MenuButton` (icon: `Link` from lucide) when `links.length >= 1`,
placed near the existing *Copy message* row:
- `links.length === 1` → copy that link, close.
- `links.length > 1` → toggle an in-sheet chooser view, reusing the existing
  `showEmojiPicker`-style toggle pattern (new `showLinkPicker` state). The chooser lists
  each URL as a `MenuButton`; tapping one copies it and closes. Reset `showLinkPicker`
  on close (mirrors the emoji-picker reset in `close()`).

### 6. i18n
New keys under `chat`:
- `chat.copyLink` — "Copy link"
- `chat.copyLinkChoose` — chooser header, e.g. "Copy which link?"

`chat.openInBrowser` already exists (used by `ImageContextMenu`). All 33 locales
translated (no English placeholders); no em-dash connectors; surgical locale edits
(parse → mutate → `stringify(, , 4) + "\n"`).

## Testing

- `extractLinks` unit test: none / one / many / duplicate / trailing-punctuation cases.
- `LinkContextMenu`: *Copy link* calls the clipboard; *Open in browser* calls
  `openInBrowser`.
- `MessageLink`: right-click (`contextmenu`) opens the menu; a component that already
  called `preventDefault` is respected (existing `useContextMenu` behavior).
- `MessageActionSheet`: *Copy link* row hidden with 0 links; copies directly with 1;
  opens the chooser with >1; chooser entries copy the right URL.
- Any new SDK/app exports asserted by tests added to the relevant test mocks /
  `test-setup.ts` i18n subset as needed.

## Out of scope

- Desktop hover toolbar (`MessageToolbar`) gets no *Copy link* button — right-clicking
  the link directly is the more precise desktop path.
- No change to `useNativeContextMenuSuppression`; the custom menu's `preventDefault`
  already stops the native menu, and suppression stays correct elsewhere.
