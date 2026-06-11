# Continue a Whispered Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user continue a MUC whisper (private message) when it is the last message in the room — via the reply button and via a clickable "Private with {nick}" thread header.

**Architecture:** Both changes live in `MessageBubble.tsx`. The existing `onReply` prop already routes private messages into whisper mode upstream (`RoomView.handleReplyToMessage` → `enterWhisperMode`), so no new wiring, no SDK change, no new i18n key. Spec: `docs/superpowers/specs/2026-06-11-whisper-continue-design.md`.

**Tech Stack:** React + TypeScript, Tailwind, Vitest + @testing-library/react.

**Branch:** `fix/whisper-continue-last-message` (already created, spec committed).

---

## Context for the implementer

- `apps/fluux/src/components/conversation/MessageBubble.tsx` renders one message row. Relevant locals (lines ~361-365):
  - `inThread = !!whisperThread` — message is part of a whisper thread.
  - `threadStart` — first row of the thread; it renders the "Private with {nick}" header (lines ~417-422).
  - `counterpartGone = inThread && counterpartPresent === false` — whisper counterpart left the room; thread is read-only.
- The reply button lives in `MessageToolbar.tsx` and renders only when the `canReply` prop is true; its accessible name is `t('chat.reply')`.
- `onReply: () => void` is already bound to the message by the parent; for private messages it enters whisper mode (with its own counterpart-gone guard + toast).
- In tests, `react-i18next` is mocked so `t(key, params)` returns the raw key (e.g. `'rooms.whisperThread'`).
- The memo comparator already invalidates on `whisperThread`, `counterpartPresent`, and `isLastMessage` (lines ~148-150, ~193); callback props are intentionally ignored. No memo change needed.
- Run app tests from `apps/fluux` (NOT bare `vitest` from repo root — it mass-fails on `@/` aliases).

---

### Task 1: Show the reply button on the last message when it is a whisper

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx:431`
- Test: `apps/fluux/src/components/conversation/MessageBubble.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add a new top-level `describe` block at the end of the `describe('MessageBubble', ...)` block in `MessageBubble.test.tsx` (after the `'Data Attributes'` block, before its closing `})`):

```tsx
  describe('Whisper threads (MUC private messages)', () => {
    // A whisper can only be continued via "reply" (it re-enters whisper mode
    // upstream), so unlike public messages the reply button must also be
    // available on the LAST message of the conversation.
    function whisperProps(overrides: Partial<MessageBubbleProps> = {}): MessageBubbleProps {
      return createDefaultProps({
        whisperThread: 'solo',
        whisperWith: 'Adrien',
        counterpartPresent: true,
        ...overrides,
      })
    }

    it('shows the reply button on the last message when it is a whisper', () => {
      render(<MessageBubble {...whisperProps({ isLastMessage: true })} />)

      expect(screen.getByRole('button', { name: 'chat.reply' })).toBeInTheDocument()
    })

    it('keeps the reply button hidden on the last message when it is public', () => {
      render(<MessageBubble {...createDefaultProps({ isLastMessage: true })} />)

      expect(screen.queryByRole('button', { name: 'chat.reply' })).not.toBeInTheDocument()
    })

    it('hides the reply button on a whisper when the counterpart left the room', () => {
      render(<MessageBubble {...whisperProps({ isLastMessage: true, counterpartPresent: false })} />)

      expect(screen.queryByRole('button', { name: 'chat.reply' })).not.toBeInTheDocument()
    })
  })
```

- [ ] **Step 2: Run the new tests to verify the right one fails**

Run: `cd /Users/mremond/AIProjects/fluux-messenger/apps/fluux && npx vitest run src/components/conversation/MessageBubble.test.tsx`

Expected: `'shows the reply button on the last message when it is a whisper'` FAILS (button absent); the two other new tests pass; all pre-existing tests pass.

- [ ] **Step 3: Fix the `canReply` condition**

In `MessageBubble.tsx` line 431, change:

```tsx
            canReply={!isLastMessage && !counterpartGone}
```

to:

```tsx
            canReply={(!isLastMessage || inThread) && !counterpartGone}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/mremond/AIProjects/fluux-messenger/apps/fluux && npx vitest run src/components/conversation/MessageBubble.test.tsx`

Expected: ALL tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger && git add apps/fluux/src/components/conversation/MessageBubble.tsx apps/fluux/src/components/conversation/MessageBubble.test.tsx && git commit -m "fix(muc): allow replying to a whisper when it is the last message"
```

---

### Task 2: Make the "Private with {nick}" thread header clickable

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx:417-422`
- Test: `apps/fluux/src/components/conversation/MessageBubble.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('Whisper threads (MUC private messages)', ...)` block from Task 1:

```tsx
    it('re-enters whisper mode when the thread header is clicked', () => {
      const onReply = vi.fn()
      render(<MessageBubble {...whisperProps({ onReply })} />)

      const header = screen.getByText('rooms.whisperThread').closest('button')
      expect(header).not.toBeNull()
      fireEvent.click(header!)

      expect(onReply).toHaveBeenCalledTimes(1)
    })

    it('renders the thread header as plain text when the counterpart left the room', () => {
      render(<MessageBubble {...whisperProps({ counterpartPresent: false })} />)

      expect(screen.getByText('rooms.whisperThread')).toBeInTheDocument()
      expect(screen.getByText('rooms.whisperThread').closest('button')).toBeNull()
    })
```

- [ ] **Step 2: Run the tests to verify the right one fails**

Run: `cd /Users/mremond/AIProjects/fluux-messenger/apps/fluux && npx vitest run src/components/conversation/MessageBubble.test.tsx`

Expected: `'re-enters whisper mode when the thread header is clicked'` FAILS (`header` is null — the header is currently a `<div>`); the plain-text test passes; all other tests pass.

- [ ] **Step 3: Implement the clickable header**

In `MessageBubble.tsx`, replace the current header block (lines 417-422):

```tsx
        {threadStart && (
          <div className="flex items-center gap-1.5 pb-1 text-xs font-medium text-fluux-private">
            <Ear className="size-3.5 shrink-0" />
            <span className="truncate">{t('rooms.whisperThread', { nick: whisperWith })}</span>
          </div>
        )}
```

with a version that is a real button while the counterpart is present (clicking it re-enters whisper mode through the same `onReply` flow as the toolbar button) and stays a plain `<div>` once the counterpart left (the thread footer already explains why it is read-only):

```tsx
        {threadStart && (counterpartGone ? (
          <div className="flex items-center gap-1.5 pb-1 text-xs font-medium text-fluux-private">
            <Ear className="size-3.5 shrink-0" />
            <span className="truncate">{t('rooms.whisperThread', { nick: whisperWith })}</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={onReply}
            title={t('rooms.sendPrivateMessage')}
            className="flex max-w-full cursor-pointer items-center gap-1.5 -ms-1 mb-0.5 rounded px-1 py-0.5 text-xs font-medium text-fluux-private transition-colors hover:bg-fluux-private-hover"
          >
            <Ear className="size-3.5 shrink-0" />
            <span className="truncate">{t('rooms.whisperThread', { nick: whisperWith })}</span>
          </button>
        ))}
```

Notes:
- `Ear` is already imported; no new imports.
- `title={t('rooms.sendPrivateMessage')}` reuses the existing occupant-menu key ("Send private message") as the tooltip — no new i18n key.
- `-ms-1 px-1 py-0.5 rounded hover:bg-fluux-private-hover` gives the hover affordance without shifting the label (negative start margin compensates the padding); `mb-0.5` + `py-0.5` ≈ the old `pb-1` spacing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/mremond/AIProjects/fluux-messenger/apps/fluux && npx vitest run src/components/conversation/MessageBubble.test.tsx`

Expected: ALL tests pass.

- [ ] **Step 5: Full verification (tests, typecheck, lint)**

Run from the repo root:

```bash
cd /Users/mremond/AIProjects/fluux-messenger && npm test && npm run typecheck && npm run lint
```

Expected: all three pass with no errors and no stderr noise.

- [ ] **Step 6: Commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger && git add apps/fluux/src/components/conversation/MessageBubble.tsx apps/fluux/src/components/conversation/MessageBubble.test.tsx && git commit -m "feat(muc): click the whisper thread header to continue the private conversation"
```

---

### Task 3: Visual verification in demo mode

**Files:** none (manual/browser verification).

- [ ] **Step 1: Verify in the running app**

Start the dev server (`npm run dev` from the repo root) and open `http://localhost:5173/demo.html?tutorial=false`. In a demo room containing a whisper thread (or after sending a whisper via an occupant's "Send private message"):

- Hovering the last message when it is a whisper shows the reply button; clicking it switches the composer to whisper mode ("Whispering privately to {nick}").
- Hovering "Private with {nick}" shows the hover background + pointer cursor; clicking it switches the composer to whisper mode.
- A public last message still shows no reply button.

If demo data needs re-seeding, clear `xmpp-chat-storage` and `fluux:activity-log` in localStorage.
