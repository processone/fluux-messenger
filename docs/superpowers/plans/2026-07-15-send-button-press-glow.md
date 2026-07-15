# Send button press + glow pulse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tactile "press + glow pulse" gesture to the composer send button that fires on every successful send, then relaxes to the grey disabled state.

**Architecture:** A short-lived `launching` state in `MessageComposer` is set on a successful send. It (a) applies a `send-launching` class to the send-button wrapper, (b) keeps the aurora-glow span mounted for the duration, and (c) is cleared on the button's `animationend`. All motion is pure CSS: the button scales (press), the glow span pulses (bloom), and the existing `transition-colors` fades the button to its disabled grey (release). No state-machine or SDK changes.

**Tech Stack:** React 18, TypeScript, Tailwind, CSS keyframes, Vitest + Testing Library.

## Global Constraints

- Reduced-motion is already handled globally: `apps/fluux/src/index.css:806` neutralizes `animation-duration`/`transition-duration` to `0.001ms` for any `:root:not([data-motion="full"])`. New keyframes need **no** manual `prefers-reduced-motion` branch.
- The aurora glow (`.send-aurora-glow`) is `display:none` on Linux/WebKitGTK (`[data-platform="linux"]`) and under `[data-transparency="reduced"]`. On those platforms only the press-scale plays (glow pulse is simply absent) — that is the intended fallback; do not add platform-specific JS.
- No new dependencies. No changes to the grey↔active disabled predicate at `MessageComposer.tsx:1032` / `:1037` beyond OR-ing in the launching flag.
- Never include a Claude footer in commits.

---

### Task 1: Wire the `launching` state in MessageComposer

**Files:**
- Modify: `apps/fluux/src/components/MessageComposer.tsx` (state near the other `useState`/`useRef` around line 240–360; success branches in `handleSubmit` at lines 543–560; send-button wrapper at lines 1031–1034)
- Test: `apps/fluux/src/components/MessageComposer.test.tsx`

**Interfaces:**
- Produces: a `launching: boolean` React state, a `send-launching` class applied to the send wrapper `<div>` when true, the `.send-aurora-glow` span kept mounted while true, and an `onAnimationEnd` handler on that wrapper that sets `launching` to `false` when `e.animationName === 'send-press'`.
- Consumes (from Task 2): the CSS animation named `send-press` whose `animationend` clears the state. Until Task 2 lands, `animationend` never fires in a real browser, but the unit test drives it synthetically.

- [ ] **Step 1: Write the failing test**

Add to `apps/fluux/src/components/MessageComposer.test.tsx` inside a new `describe`:

```tsx
describe('send-button launch animation', () => {
  const setupSend = () => {
    const onSend = vi.fn().mockResolvedValue(true)
    render(
      <MessageComposer
        placeholder="Type a message"
        onSend={onSend}
        classifyInput={() => 'send'}
      />
    )
    const textarea = screen.getByPlaceholderText('Type a message') as HTMLTextAreaElement
    const wrapper = textarea
      .closest('form')!
      .querySelector('button[type="submit"]')!
      .parentElement as HTMLElement
    return { onSend, textarea, wrapper }
  }

  it('adds send-launching to the wrapper after a successful send', async () => {
    const { textarea, wrapper } = setupSend()
    fireEvent.change(textarea, { target: { value: 'hello' } })
    await act(async () => {
      fireEvent.submit(textarea.closest('form') as HTMLFormElement)
    })
    expect(wrapper.classList.contains('send-launching')).toBe(true)
  })

  it('keeps the aurora glow mounted while launching', async () => {
    const { textarea, wrapper } = setupSend()
    fireEvent.change(textarea, { target: { value: 'hello' } })
    await act(async () => {
      fireEvent.submit(textarea.closest('form') as HTMLFormElement)
    })
    // Input is now cleared (button disabled) but the glow persists for the pulse.
    expect(wrapper.querySelector('.send-aurora-glow')).not.toBeNull()
  })

  it('clears send-launching when the send-press animation ends', async () => {
    const { textarea, wrapper } = setupSend()
    fireEvent.change(textarea, { target: { value: 'hello' } })
    await act(async () => {
      fireEvent.submit(textarea.closest('form') as HTMLFormElement)
    })
    await act(async () => {
      fireEvent.animationEnd(wrapper, { animationName: 'send-press' })
    })
    expect(wrapper.classList.contains('send-launching')).toBe(false)
    expect(wrapper.querySelector('.send-aurora-glow')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/MessageComposer.test.tsx -t "launch animation"`
Expected: FAIL — `send-launching` class is never applied (wrapper has no such class).

- [ ] **Step 3: Add the `launching` state**

Near the other `useState` declarations (e.g. just after the existing composer state around line 300), add:

```tsx
// Brief "press + glow pulse" gesture fired on a successful send; cleared when
// the CSS `send-press` animation ends. Keeps the aurora glow mounted for the
// pulse even though the input (and thus the enabled state) has already cleared.
const [launching, setLaunching] = useState(false)
```

- [ ] **Step 4: Trigger it on successful send**

In `handleSubmit`, in the correction branch (line 547–551) and the normal-send branch (line 555–559), call `setLaunching(true)` right after the successful `setText('')`. Concretely, change:

```tsx
        handled = await onSendCorrection(editingMessage.id, trimmed, attachmentToKeep)
        if (handled) {
          setText('')
          onCancelEdit?.()
          inputRef.current?.focus()
        }
```
to add `setLaunching(true)` after `setText('')`:
```tsx
        handled = await onSendCorrection(editingMessage.id, trimmed, attachmentToKeep)
        if (handled) {
          setText('')
          setLaunching(true)
          onCancelEdit?.()
          inputRef.current?.focus()
        }
```
and likewise in the normal-send branch:
```tsx
        handled = await onSend(outgoingText)
        if (handled) {
          setText('')
          setLaunching(true)
          onCancelReply?.()
          inputRef.current?.focus()
        }
```
Do NOT add it to the retract branch (lines 537–542) — a retraction removes a message, it is not a send.

- [ ] **Step 5: Apply the class, keep the glow mounted, clear on animation end**

At the send-button wrapper (lines 1031–1034), change the wrapper `<div>` to carry the class and the animation-end handler, and OR `launching` into the glow-render condition:

```tsx
        <div
          className={`relative m-1 flex [grid-area:send]${launching ? ' send-launching' : ''}`}
          onAnimationEnd={(e) => {
            if (e.animationName === 'send-press') setLaunching(false)
          }}
        >
          {(!((!text.trim() && !pendingAttachment) || sending || disabled || sendDisabled) || launching) && (
            <span className="send-aurora-glow" aria-hidden="true" />
          )}
```

Leave the `<button>` (line 1035 onward) unchanged.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/components/MessageComposer.test.tsx -t "launch animation"`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full composer suite for regressions**

Run: `npx vitest run src/components/MessageComposer.test.tsx`
Expected: PASS, no stderr.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/components/MessageComposer.tsx apps/fluux/src/components/MessageComposer.test.tsx
git commit -m "feat(composer): fire send-launch state on successful send"
```

---

### Task 2: Add the press + glow-pulse CSS

**Files:**
- Modify: `apps/fluux/src/index.css` (append immediately after the send-button block that ends at line 1545, before the "Aurora backlight in the modal scrim" comment at line 1547)

**Interfaces:**
- Consumes (from Task 1): the `send-launching` class on the send wrapper and the persisted `.send-aurora-glow` child.
- Produces: `@keyframes send-press` (drives the button scale; its name is what Task 1's `onAnimationEnd` matches) and `@keyframes send-glow-pulse`.

- [ ] **Step 1: Add the keyframes and rules**

Insert after line 1545 (after the `:root[data-platform="linux"] .send-aurora-glow { display: none; }` rule):

```css
/* Send "launch" gesture: on a successful send the button briefly presses in
   (scale) while the aurora glow blooms and fades, then `transition-colors`
   settles the button into its disabled grey. Placed after the disabled/fallback
   rules so it composes with them; adds only transform/opacity, never touching
   the disabled background reset. Reduced-motion is neutralized globally (see the
   prefers-reduced-motion block above). On Linux/reduced-transparency the glow is
   display:none, so only the press-scale plays. */
@keyframes send-press {
  0% { transform: scale(1); }
  38% { transform: scale(0.9); }
  100% { transform: scale(1); }
}
@keyframes send-glow-pulse {
  0% { opacity: 0.6; transform: scale(1); }
  35% { opacity: 1; transform: scale(1.35); }
  100% { opacity: 0; transform: scale(1.5); }
}
.send-launching .send-aurora {
  animation: send-press 280ms ease;
}
.send-launching .send-aurora-glow {
  animation: send-glow-pulse 260ms ease-out forwards;
}
```

- [ ] **Step 2: Build the app to confirm the CSS compiles**

Run: `npm run build 2>&1 | tail -5`
Expected: build succeeds (no CSS/PostCSS error). If `build:sdk` is slow, `npx vite build apps/fluux` on its own is acceptable.

- [ ] **Step 3: Verify the gesture in demo mode**

Start the dev server and open demo mode:
- `preview_start` with the dev server, navigate to `http://localhost:5173/demo.html?tutorial=false`.
- Open a conversation, type a message, send it (both via the Send button click and via the Enter key).
- Confirm: the button visibly presses in and the aurora glow blooms then fades, settling to grey. Take a screenshot mid-gesture if the throttled renderer allows; otherwise assert the `send-launching` class appears on the wrapper via `read_page`/`javascript_tool` right after a send.
- Note (from repo memory): headless preview may freeze rAF/transitions — if the animation can't be captured visually, verifying the `send-launching` class toggles (already covered by the Task 1 unit test) plus a clean build is sufficient evidence.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/index.css
git commit -m "style(composer): press + glow-pulse animation on send"
```

---

## Self-Review

- **Spec coverage:** Press (Task 2 `send-press`) ✓; glow bloom (Task 2 `send-glow-pulse` + Task 1 keeps glow mounted) ✓; release to grey (existing `transition-colors`, noted in architecture) ✓; fires on any send incl. attachment/command/correction (Task 1 Step 4 covers `onSend` + `onSendCorrection`; commands that reach `onSend` are covered, consumed commands correctly do not animate) ✓; trigger via JS class not `:active` (Task 1) ✓; reduced-motion (global rule, Global Constraints) ✓; Linux/reduced-transparency fallback = press-only (Global Constraints + Task 2 comment) ✓.
- **Placeholder scan:** none.
- **Type consistency:** `launching` boolean, `setLaunching`, class string `send-launching`, animation name `send-press` — used identically in Task 1 (JS match) and Task 2 (keyframe definition).
- **Known limitation (acceptable):** a second send while `launching` is still true will not restart the animation (class already present); the `sending` gate and refocus make rapid double-sends unlikely. Not worth a counter/reflow hack.
