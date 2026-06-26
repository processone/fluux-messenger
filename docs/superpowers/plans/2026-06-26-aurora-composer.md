# Aurora Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the shared message composer into an Aurora contained card with an accent focus-edge, a filled accent send button, the reply/edit/whisper context unified inside the card, a per-person reply-chip color, and a calm-by-default end-to-end-encryption reminder that escalates on a key change.

**Architecture:** All visual work lives in the one shared `MessageComposer.tsx` (consumed by `ChatView`'s `MessageInput` for 1:1 and `RoomView`'s `RoomMessageInput` for rooms), so both contexts inherit it. The encryption indicator reads the existing `encryptionState` prop; the reply color flows through a new optional field on the existing `ReplyInfo` type computed by the wrappers; the tappable lock reuses the `onEncryptionClick` handler the wrappers already pass to the header. The focus-edge is pure CSS `:focus-within` — no React focus state.

**Tech Stack:** React + TypeScript, Tailwind, CSS custom properties (Aurora tokens in `apps/fluux/src/index.css`), Vitest + Testing Library, lucide-react icons.

## Global Constraints

- **Render-perf (binding):** No new store subscriptions. No new prop that changes on every keystroke (`encryptionState`, the reply color, and `onEncryptionClick` change only on conversation/reply change). The `composer-active` toolbar-hiding mechanism (`index.css` `.composer-active`, toggled in `ChatView`/`RoomView`) must stay untouched. `apps/fluux/src/components/messageRowMemo.test.tsx` must stay green — composer changes must not re-render message rows.
- **Focus-edge is CSS only:** use `:focus-within`; do NOT add React focus state.
- **Tokens (use these exact names):** card border `var(--fluux-border)`; radius `var(--fluux-radius-l)` (12px); focus ring `hsla(var(--fluux-accent-h), var(--fluux-accent-s), var(--fluux-accent-l), 0.22)`; accent fill `var(--fluux-brand)` / hover `var(--fluux-brand-hover)`; encryption teal `var(--fluux-accent-2)`; key-change amber `var(--fluux-status-warning)`.
- **Encryption state mapping (calm by default):**
  - `kind: 'encrypted'`, `trust: 'verified'` → teal `ShieldCheck`.
  - `kind: 'encrypted'`, `trust: 'unverified' | 'tofu-new'` → teal `Lock`.
  - `kind: 'blocked'` → amber `ShieldAlert` + the docked amber escalation row (key changed).
  - all other kinds (`disabled`, `checking`, `plaintextForced`, `unsupported`, `rejected`, `keyLocked`) → **no lock** (clean composer).
- **No logic changes:** send/typing/attachment/poll/mention behavior is unchanged — this is a presentation slice.
- **User-facing strings:** reuse existing i18n keys (the header's `EncryptionIcon` and the key-change alert already have encryption/verify strings). Do NOT add new locale keys in this slice. **No em-dashes or en-dashes** in any user-facing text.
- **Both themes:** verify the focus-edge, lock, and escalation row read in light mode (tokens already invert).

## File Structure

- `apps/fluux/src/index.css` — add the `.composer-card` class (border, radius, `:focus-within` edge). MODIFY.
- `apps/fluux/src/components/MessageComposer.tsx` — card wrapper refactor, filled send, leading lock, escalation row, reply-color consumption, `ReplyInfo.senderColor` + `onEncryptionClick` props. MODIFY.
- `apps/fluux/src/components/MessageComposer.test.tsx` — extend with new describe blocks. MODIFY.
- `apps/fluux/src/components/ChatView.tsx` — set `replyInfo.senderColor`; thread `onEncryptionClick` to the composer. MODIFY.
- `apps/fluux/src/components/RoomView.tsx` — set `replyInfo.senderColor`; align the whisper banner with the card. MODIFY.
- `scripts/screenshots.ts` — add a composer-states scene. MODIFY.

---

### Task 1: Composer card structure + accent focus-edge

**Files:**
- Modify: `apps/fluux/src/index.css` (add `.composer-card`, near the existing composer block around line 687)
- Modify: `apps/fluux/src/components/MessageComposer.tsx` (render tree, lines ~658-941)
- Test: `apps/fluux/src/components/MessageComposer.test.tsx`

**Interfaces:**
- Produces: a `.composer-card` wrapper `<div>` containing all context sections + the input row. The input row is no longer self-backgrounded/rounded; the card carries `bg-fluux-hover` + border + radius + the `:focus-within` edge. Context sections use `border-b border-fluux-border` dividers instead of `rounded-t-lg`.

- [ ] **Step 1: Write the failing test**

```tsx
// In MessageComposer.test.tsx, add a new describe block at the top level:
describe('Aurora card', () => {
  it('wraps context and input in a single .composer-card', () => {
    const { container } = render(
      <MessageComposer
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        replyingTo={{ id: '1', from: 'emma@x.com', senderName: 'Emma', body: 'hi' }}
        onCancelReply={vi.fn()}
      />
    )
    const card = container.querySelector('.composer-card')
    expect(card).not.toBeNull()
    // The reply preview lives INSIDE the card (docked), not as a sibling above it.
    expect(card!.textContent).toContain('Emma')
    // The textarea also lives inside the same card.
    expect(card!.querySelector('textarea')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx -t "Aurora card"`
Expected: FAIL (no `.composer-card` element yet).

- [ ] **Step 3: Add the CSS class**

In `apps/fluux/src/index.css`, near the existing composer block (~line 687, the `.composer-active` comment), add:

```css
/*
 * Aurora composer card. The bar that wraps the context sections + input row.
 * Background is applied as a utility (bg-fluux-hover) on the element; this class
 * owns the hairline border, radius, and the signature accent focus-edge. The
 * focus-edge is pure :focus-within (no React focus state) so it never touches
 * the typing render path. No overflow:hidden here — the attach/emoji popups are
 * absolutely positioned above the card and must not be clipped.
 */
.composer-card {
  border: 1px solid var(--fluux-border);
  border-radius: var(--fluux-radius-l);
}
.composer-card:focus-within {
  border-color: var(--fluux-brand);
  box-shadow: 0 0 0 3px hsla(var(--fluux-accent-h), var(--fluux-accent-s), var(--fluux-accent-l), 0.22);
}
```

- [ ] **Step 4: Refactor the render tree to use the card**

In `MessageComposer.tsx`, wrap the context sections + input row in the card. Change the structure so:
1. A new `<div className="composer-card bg-fluux-hover">` wraps everything from the edit indicator through the input row.
2. Each context section (edit ~665, reply ~714, pending attachment ~743, upload error ~796) drops its own `bg-fluux-hover` and `rounded-t-lg`, and instead ends with `border-b border-fluux-border` (a divider above the next section / input row). Keep their `border-s-2` left-edge markers and `px-3 py-2`.
3. The input-row `<div>` (currently line 809 `bg-fluux-hover ... rounded-b-lg/rounded-lg flex items-center`) becomes just `<div className="flex items-center">` (no bg, no rounded — the card owns those).

Concretely, the return becomes (showing the wrapper + the changed section headers; inner content of each section is unchanged except the className):

```tsx
return (
  <form onSubmit={handleSubmit} className="px-4 pt-2 pb-safe relative">
    {aboveInput}
    <div className="composer-card bg-fluux-hover">
      {/* Edit indicator */}
      {editingMessage && (
        <div className={`px-3 py-2 flex items-start gap-2 border-s-2 border-b border-fluux-border ${willDeleteMessage ? 'border-s-red-500' : 'border-s-green-500'}`}>
          {/* ...unchanged inner content... */}
        </div>
      )}

      {/* Reply preview */}
      {replyingTo && !editingMessage && (
        <div className="px-3 py-2 flex items-start gap-2 border-s-2 border-b border-fluux-border border-s-fluux-brand">
          {/* ...unchanged inner content (reply color handled in Task 4)... */}
        </div>
      )}

      {/* Pending attachment preview */}
      {pendingAttachment && !editingMessage && (
        <div className="px-3 py-2 flex items-center gap-3 border-s-2 border-b border-fluux-border border-s-fluux-brand">
          {/* ...unchanged inner content... */}
        </div>
      )}

      {/* Upload error banner */}
      {uploadState?.error && (
        <div className="bg-fluux-red/10 px-3 py-2 flex items-center gap-2 border-b border-fluux-border">
          {/* ...unchanged inner content... */}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-center">
        {/* ...unchanged: hidden file input, attach menu, input, emoji, send... */}
      </div>
    </div>
  </form>
)
```

Notes:
- The edit border color was `border-red-500`/`border-green-500` on a `border-s-2` element; since we now also set `border-b`, change the left-edge color utilities to the side-specific `border-s-red-500`/`border-s-green-500` so the bottom divider stays `border-fluux-border`. Same idea for the reply/attachment `border-fluux-brand` → `border-s-fluux-brand`.
- The last context section before the input row still gets `border-b` (it divides from the input). The input row itself has no top border (the section above provides the divider). When no context is present, the input row is the only child and the card shows just the input.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx -t "Aurora card"`
Expected: PASS.

- [ ] **Step 6: Run the full composer + perf guard tests**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx src/components/messageRowMemo.test.tsx`
Expected: PASS (no regression; perf guard green).

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/src/components/MessageComposer.tsx apps/fluux/src/components/MessageComposer.test.tsx
git -c commit.gpgsign=false commit -m "feat(composer): contained Aurora card with accent focus-edge"
```

---

### Task 2: Filled accent send button

**Files:**
- Modify: `apps/fluux/src/components/MessageComposer.tsx` (send button ~918-939)
- Test: `apps/fluux/src/components/MessageComposer.test.tsx`

**Interfaces:**
- Consumes: the input row from Task 1.
- Produces: a filled accent send button. The send-button **encryption badge overlay and its Tooltip are removed** (encryption moves to the leading lock in Task 3). The `sendBadge` (whisper) prop still renders, now unconditionally.

- [ ] **Step 1: Write the failing test**

```tsx
describe('Aurora send button', () => {
  it('is a filled accent button when there is text, with no encryption badge on it', () => {
    const { container } = render(
      <MessageComposer
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        encryptionState={{ kind: 'encrypted', fingerprint: 'abc', trust: 'verified' }}
      />
    )
    const textarea = screen.getByPlaceholderText('Type a message')
    fireEvent.change(textarea, { target: { value: 'hi' } })
    const send = container.querySelector('button[type="submit"]')!
    expect(send.className).toContain('bg-fluux-brand')
    // The encryption badge no longer lives on the send button (moved to the leading lock).
    expect(send.querySelector('.lucide-shield-check')).toBeNull()
  })

  it('still renders the whisper sendBadge on the send button', () => {
    const { container } = render(
      <MessageComposer
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        sendBadge={<span data-testid="whisper-badge" />}
      />
    )
    const send = container.querySelector('button[type="submit"]')!
    expect(send.querySelector('[data-testid="whisper-badge"]')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx -t "Aurora send button"`
Expected: FAIL (send is not `bg-fluux-brand`; the ShieldCheck is still on the send button).

- [ ] **Step 3: Replace the send button**

In `MessageComposer.tsx`, replace the send button block (currently the `<Tooltip>...<button type="submit">...</button></Tooltip>` at ~918-939) with a plain filled button (no Tooltip, no encryption ternary):

```tsx
{/* Send button — filled accent. Encryption state is shown by the leading lock (not here). */}
<button
  type="submit"
  disabled={(!text.trim() && !pendingAttachment) || sending || disabled || sendDisabled}
  aria-label={t('chat.send', 'Send')}
  className="group/send relative m-1 p-2.5 rounded-xl tap-target flex items-center justify-center
             bg-fluux-brand text-white hover:bg-fluux-brand-hover
             disabled:bg-transparent disabled:text-fluux-muted disabled:cursor-not-allowed
             transition-colors"
>
  <Send className="rtl-mirror size-5" />
  {sendBadge}
</button>
```

Remove the now-unused `<Tooltip>` wrapper around send and any imports that become unused **only if** they are no longer referenced anywhere else in the file (check `ShieldCheck` — it is reused in Task 3 for the lock, so keep it; `Tooltip` is still used by other buttons, keep it).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx -t "Aurora send button"`
Expected: PASS.

- [ ] **Step 5: Run the composer + perf guard tests**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx src/components/messageRowMemo.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/MessageComposer.tsx apps/fluux/src/components/MessageComposer.test.tsx
git -c commit.gpgsign=false commit -m "feat(composer): filled accent send button; retire send-button encryption badge"
```

---

### Task 3: Leading encryption lock + key-change escalation row (tappable)

**Files:**
- Modify: `apps/fluux/src/components/MessageComposer.tsx` (props interface ~150-157; input row leading area ~876; a new escalation section in the card)
- Modify: `apps/fluux/src/components/ChatView.tsx` (thread `onEncryptionClick` to the composer)
- Test: `apps/fluux/src/components/MessageComposer.test.tsx`

**Interfaces:**
- Consumes: the existing `encryptionState?: ConversationEncryptionState` prop; the card + input row from Tasks 1-2.
- Produces: a new optional prop `onEncryptionClick?: () => void`. A leading lock element in the input row (after the attach menu, before the input) and a docked amber escalation row in the card (for `kind: 'blocked'`). Both are buttons calling `onEncryptionClick` when provided, else non-interactive spans.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('Aurora encryption lock', () => {
  const base = { placeholder: 'Type a message', onSend: vi.fn().mockResolvedValue(true) }

  it('shows no lock when not encrypted', () => {
    const { container } = render(<MessageComposer {...base} encryptionState={{ kind: 'disabled' }} />)
    expect(container.querySelector('[data-encryption-lock]')).toBeNull()
  })

  it('shows a teal lock when encrypted but unverified', () => {
    const { container } = render(<MessageComposer {...base} encryptionState={{ kind: 'encrypted', fingerprint: 'a', trust: 'unverified' }} />)
    const lock = container.querySelector('[data-encryption-lock]')!
    expect(lock).not.toBeNull()
    expect(lock.querySelector('.lucide-lock')).not.toBeNull()
  })

  it('shows a shield-check when verified', () => {
    const { container } = render(<MessageComposer {...base} encryptionState={{ kind: 'encrypted', fingerprint: 'a', trust: 'verified' }} />)
    expect(container.querySelector('[data-encryption-lock] .lucide-shield-check')).not.toBeNull()
  })

  it('shows the amber escalation row when the key changed (blocked)', () => {
    const { container } = render(<MessageComposer {...base} encryptionState={{ kind: 'blocked', pinnedFingerprint: 'a', advertisedFingerprint: 'b' }} />)
    expect(container.querySelector('[data-encryption-escalation]')).not.toBeNull()
  })

  it('calls onEncryptionClick when the lock is activated', () => {
    const onEncryptionClick = vi.fn()
    const { container } = render(<MessageComposer {...base} onEncryptionClick={onEncryptionClick} encryptionState={{ kind: 'encrypted', fingerprint: 'a', trust: 'unverified' }} />)
    fireEvent.click(container.querySelector('[data-encryption-lock]')!)
    expect(onEncryptionClick).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx -t "Aurora encryption lock"`
Expected: FAIL (no lock element).

- [ ] **Step 3: Add the prop**

In `MessageComposerProps` (after `sendBadge`, ~157), add:

```tsx
  /**
   * Open the verify/trust UI for the current peer. Wired by the 1:1 wrapper
   * (the same handler the header's EncryptionIcon uses). When set, the leading
   * lock and the key-change escalation are interactive; when absent they are
   * non-interactive reminders. Rooms never set this (group E2EE is disabled).
   */
  onEncryptionClick?: () => void
```

Add `onEncryptionClick,` to the destructured params (near `sendBadge,` ~191).

- [ ] **Step 4: Derive the lock state and add the elements**

Before the `return (`, compute the lock descriptor (reuse the existing `t`, and `Lock`/`ShieldCheck`/`ShieldAlert` from lucide-react — add `ShieldAlert` to the import if missing):

```tsx
// Aurora encryption reminder. Calm by default (teal lock/shield), escalates to
// amber only on a real key change ('blocked'). Everything else shows nothing.
const enc = encryptionState
const lockInfo: { Icon: typeof Lock; color: string; label: string } | null =
  enc?.kind === 'encrypted'
    ? enc.trust === 'verified'
      ? { Icon: ShieldCheck, color: 'var(--fluux-accent-2)', label: t('chat.encryption.verifiedTooltip') }
      : { Icon: Lock, color: 'var(--fluux-accent-2)', label: t('chat.encryption.openpgpTooltip') }
    : enc?.kind === 'blocked'
      ? { Icon: ShieldAlert, color: 'var(--fluux-status-warning)', label: t('chat.encryption.openpgpTooltip') }
      : null
const keyChanged = enc?.kind === 'blocked'
```

(Use the existing encryption i18n keys already referenced in this file at the old send-button Tooltip — `chat.encryption.verifiedTooltip` and `chat.encryption.openpgpTooltip`. If a more specific key-change string already exists in the locale files, prefer it for the escalation row; do not add new keys.)

Add the escalation row as the **last context section inside the card**, just before the input row `<div className="flex items-center">`:

```tsx
{/* Key-change escalation (amber) — docked in the card, calls out the one moment that matters */}
{keyChanged && (
  <button
    type="button"
    data-encryption-escalation
    onClick={onEncryptionClick}
    disabled={!onEncryptionClick}
    className="w-full text-start px-3 py-2 flex items-center gap-2 border-s-2 border-b border-fluux-border"
    style={{ borderInlineStartColor: 'var(--fluux-status-warning)' }}
  >
    <ShieldAlert className="size-4 flex-shrink-0" style={{ color: 'var(--fluux-status-warning)' }} />
    <span className="text-xs font-medium" style={{ color: 'var(--fluux-status-warning)' }}>
      {t('chat.encryption.openpgpTooltip')}
    </span>
  </button>
)}
```

Add the leading lock in the input row, immediately after the attach-menu `</div>` (~874) and before the input block (~876):

```tsx
{lockInfo && (
  onEncryptionClick ? (
    <button
      type="button"
      data-encryption-lock
      onClick={onEncryptionClick}
      aria-label={lockInfo.label}
      className="p-1.5 flex-shrink-0 rounded-lg hover:bg-fluux-bg transition-colors"
    >
      <lockInfo.Icon className="size-4" style={{ color: lockInfo.color }} />
    </button>
  ) : (
    <span data-encryption-lock aria-label={lockInfo.label} className="p-1.5 flex-shrink-0">
      <lockInfo.Icon className="size-4" style={{ color: lockInfo.color }} />
    </span>
  )
)}
```

- [ ] **Step 5: Wire `onEncryptionClick` from the 1:1 wrapper**

In `ChatView.tsx`, find where `MessageInput`/`MessageComposer` is rendered with `encryptionState={encryptionState}` (e.g. line ~1185) and add the handler that is already passed to `ChatHeader` (`onEncryptionClick`). If `onEncryptionClick` is a prop of `ChatView` not yet threaded into the inner `MessageInput`, thread it through (it is the same callback the header uses to open the verify dialog). Add to the composer render:

```tsx
onEncryptionClick={onEncryptionClick}
```

(Do NOT wire it in `RoomView` — rooms are always `kind: 'disabled'`, so the lock never renders there.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx -t "Aurora encryption lock"`
Expected: PASS.

- [ ] **Step 7: Run composer + ChatView + perf guard tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx src/components/ChatView.test.tsx src/components/messageRowMemo.test.tsx`
Then from repo root: `npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/MessageComposer.tsx apps/fluux/src/components/MessageComposer.test.tsx apps/fluux/src/components/ChatView.tsx
git -c commit.gpgsign=false commit -m "feat(composer): calm leading encryption lock with key-change escalation"
```

---

### Task 4: Reply-chip per-person color + whisper banner alignment

**Files:**
- Modify: `apps/fluux/src/components/MessageComposer.tsx` (`ReplyInfo` interface ~42-48; reply preview ~714-719)
- Modify: `apps/fluux/src/components/ChatView.tsx` (`replyInfo` build ~1035-1042)
- Modify: `apps/fluux/src/components/RoomView.tsx` (`replyInfo` build ~1749-1756; whisper banner styling)
- Test: `apps/fluux/src/components/MessageComposer.test.tsx`

**Interfaces:**
- Consumes: the reply preview section from Task 1; `auroraSenderColor` from `@/utils/senderColor`.
- Produces: `ReplyInfo.senderColor?: string`. The composer colors the reply chip's icon, name, and left-edge with it (fallback `var(--fluux-brand)`). Wrappers compute it: 1:1 `auroraSenderColor(from.split('/')[0], isDarkMode ?? true)`, rooms `auroraSenderColor(nick, isDarkMode ?? true)` — matching the in-thread reply chips from slice #1.

- [ ] **Step 1: Write the failing test**

```tsx
describe('Aurora reply-chip color', () => {
  it('colors the reply chip with the replied-person color', () => {
    const { container } = render(
      <MessageComposer
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        replyingTo={{ id: '1', from: 'emma@x.com', senderName: 'Emma', body: 'hi', senderColor: 'rgb(154, 212, 255)' }}
        onCancelReply={vi.fn()}
      />
    )
    // The "Replying to Emma" line is colored with the provided sender color.
    const name = screen.getByText(/Replying to/i)
    expect(name.getAttribute('style')).toContain('rgb(154, 212, 255)')
  })

  it('falls back to the brand color when no senderColor is given', () => {
    render(
      <MessageComposer
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        replyingTo={{ id: '1', from: 'emma@x.com', senderName: 'Emma', body: 'hi' }}
        onCancelReply={vi.fn()}
      />
    )
    const name = screen.getByText(/Replying to/i)
    expect(name.getAttribute('style')).toContain('var(--fluux-brand)')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx -t "Aurora reply-chip color"`
Expected: FAIL (`senderColor` not on `ReplyInfo`; the name uses `text-fluux-brand` not an inline style).

- [ ] **Step 3: Add the field + consume it**

In `MessageComposer.tsx`, extend `ReplyInfo`:

```tsx
export interface ReplyInfo {
  id: string
  senderName: string
  body: string
  // Full data for constructing reply
  from: string
  /** Per-person Aurora color (auroraSenderColor of the replied sender); falls back to the brand accent. */
  senderColor?: string
}
```

In the reply preview (~714-719), replace the hardcoded brand utilities with the per-person color (define a local `const replyColor = replyingTo.senderColor || 'var(--fluux-brand)'` at the top of the `replyingTo && ...` block):

```tsx
{replyingTo && !editingMessage && (() => {
  const replyColor = replyingTo.senderColor || 'var(--fluux-brand)'
  return (
    <div className="px-3 py-2 flex items-start gap-2 border-s-2 border-b border-fluux-border"
         style={{ borderInlineStartColor: replyColor }}>
      <Reply className="rtl-mirror size-4 flex-shrink-0 mt-0.5" style={{ color: replyColor }} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium" style={{ color: replyColor }}>
          Replying to {replyingTo.senderName}
        </p>
        {/* ...unchanged quote/hidden body... */}
      </div>
      {/* ...unchanged cancel button... */}
    </div>
  )
})()}
```

(Keep the `border-s-fluux-brand` utility off this element now that the inline `borderInlineStartColor` drives it.)

- [ ] **Step 4: Compute `senderColor` in the wrappers**

In `ChatView.tsx` (`replyInfo` build ~1035-1042), add the field (ensure `auroraSenderColor` is imported and `isDarkMode` is in scope — both are, from slice #1):

```tsx
const replyInfo: ReplyInfo | null = replyingTo
  ? {
      id: replyingTo.id,
      from: replyingTo.from,
      senderName: contactsByJid.get(replyingTo.from.split('/')[0])?.name || replyingTo.from.split('@')[0],
      body: replyingTo.body,
      senderColor: auroraSenderColor(replyingTo.from.split('/')[0], isDarkMode ?? true),
    }
  : null
```

In `RoomView.tsx` (`replyInfo` build ~1749-1756), add (rooms color by nick, matching the live room; import `auroraSenderColor`; confirm `isDarkMode` is in scope in `RoomMessageInput`, deriving it the same way slice #1 did if needed):

```tsx
const replyInfo: ReplyInfo | null = replyingTo
  ? {
      id: replyingTo.stanzaId || replyingTo.id,
      from: replyingTo.from,
      senderName: replyingTo.nick,
      body: replyingTo.body,
      senderColor: auroraSenderColor(replyingTo.nick, isDarkMode ?? true),
    }
  : null
```

- [ ] **Step 5: Align the whisper banner with the card**

In `RoomView.tsx`, the whisper banner rendered just outside `MessageComposer` (around the `RoomMessageInput` return / the `sendBadge={whisperTarget ...}` area ~2083-2138) should read as part of the card: give it the same horizontal inset as the composer (`px-4`) and a violet `border-s-2` so it visually docks above the card. Keep its existing violet semantics and text; do not add new strings. (Minimal CSS alignment only.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx -t "Aurora reply-chip color"`
Expected: PASS.

- [ ] **Step 7: Run composer + wrapper + perf guard tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx src/components/ChatView.test.tsx src/components/RoomView.test.tsx src/components/messageRowMemo.test.tsx`
Then from repo root: `npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/MessageComposer.tsx apps/fluux/src/components/MessageComposer.test.tsx apps/fluux/src/components/ChatView.tsx apps/fluux/src/components/RoomView.tsx
git -c commit.gpgsign=false commit -m "feat(composer): per-person reply-chip color + whisper banner alignment"
```

---

### Task 5: Screenshot scene + full verification

**Files:**
- Modify: `scripts/screenshots.ts` (add a composer-states scene)
- Verify: whole suite, typecheck, lint, screenshots

**Interfaces:**
- Consumes: the finished composer (Tasks 1-4).
- Produces: a new screenshot scene exercising the composer states (resting, focused, replying with per-person color, encrypted lock, key-change escalation) for visual regression of the CSS-only states the unit tests cannot assert.

- [ ] **Step 1: Add the scene**

In `scripts/screenshots.ts`, follow the existing scene pattern (as slice #1 did for scene 30) to add a composer-states scene: open a 1:1 conversation, capture (a) resting, (b) focused (the textarea focused, to show the accent edge), (c) a reply in progress (per-person colored chip), and (d) an encrypted conversation (leading lock). Use the existing demo data + the established scene scaffolding. Name the outputs e.g. `31-composer-states-dark.png` / `-light.png`.

- [ ] **Step 2: Typecheck + lint**

Run from repo root:
```bash
npm run typecheck
npm run lint
```
Expected: clean, 0 errors.

- [ ] **Step 3: Full test suite**

Run from repo root: `npm test`
Expected: all pass, no stderr. Confirm `messageRowMemo` is among the green tests (render-perf guard intact).

- [ ] **Step 4: Generate screenshots**

Run from repo root: `npm run screenshots`
Expected: completes; the new composer scene PNGs are produced.

- [ ] **Step 5: Commit**

```bash
git add scripts/screenshots.ts screenshots/
git -c commit.gpgsign=false commit -m "feat(composer): composer-states screenshot scene + regen"
```

---

## Self-Review

**Spec coverage:**
- Contained card + radius + hairline → Task 1. ✓
- Accent focus-edge (`:focus-within`) → Task 1. ✓
- Filled accent send button + retire send-badge encryption overlay → Task 2. ✓
- Context docked inside the card → Task 1 (structure) + Task 4 (reply color). ✓
- Reply-chip per-person hue (the (a) touch) → Task 4. ✓
- Encryption leading lock, calm states, no lock for plaintext → Task 3. ✓
- Key-change escalation row (amber) → Task 3. ✓
- Tappable lock routing to verify → Task 3 (via existing `onEncryptionClick`). ✓
- Shared component → both 1:1 + rooms; rooms never show the lock (disabled) → covered (RoomView not wired). ✓
- Whisper banner alignment → Task 4. ✓
- Render-perf (no new subscriptions, no keystroke-frequency props, `composer-active` untouched, `messageRowMemo` green) → Global Constraints + tested in Tasks 1-4, gated in Task 5. ✓
- AA / both themes → verified visually in Task 5 (screenshots) + tokens chosen to clear contrast.
- i18n reuse + no em-dash → Global Constraints. ✓
- Density-aware height → explicitly deferred (out of scope). ✓

**Placeholder scan:** no TBD/TODO; every code step shows real code. The only "find it" steps (Task 3 step 5 threading `onEncryptionClick`; Task 4 step 4 confirming `isDarkMode` scope; Task 5 scene) reference concrete existing anchors.

**Type consistency:** `ReplyInfo.senderColor?: string` defined in Task 4 and consumed there; `onEncryptionClick?: () => void` defined and consumed in Task 3; `ConversationEncryptionState` kinds used match the type (`disabled`/`encrypted`+`trust`/`blocked`). `auroraSenderColor(identifier, isDarkMode)` signature matches slice #1.

## Open flags for the controller / human

- **Lock interactivity scope:** Task 3 makes the lock tappable by reusing the wrapper's existing `onEncryptionClick`. If threading it into the inner `MessageInput` proves more involved than a prop pass, the lock degrades gracefully to a non-interactive reminder (the prop is optional) and tappability becomes a fast follow. Flag if encountered.
- **Escalation-row copy:** the plan reuses the existing `chat.encryption.*` keys to honor the no-new-locale-keys constraint. If a dedicated "key changed, verify" string is wanted, that is a separate i18n change (33 locales) and out of this slice.
