# Aurora Motion Language: Design Spec

- Status: Approved (design), pending spec review
- Date: 2026-06-29
- Scope: `apps/fluux`. A motion-token vocabulary plus modal / dialog / command-palette enter-exit animation. Effort S to M.
- Builds on: the existing pure-CSS motion system (no animation library).

## Goal

The app already has a mature, motion-preference-compliant animation system: send animation, reaction burst, a spring scroll-to-bottom button, typing dots, occupant drawer, toasts, all gated by a global `data-motion` switch. Two things are missing. First, the durations and easings are ad-hoc one-offs with no shared vocabulary. Second, modal dialogs and the command palette pop in and out with no animation, which reads as unfinished next to the frosted-glass surfaces shipped in the glass slice. This slice defines a small named motion vocabulary (the "language"), migrates the existing animations onto it without changing how they feel, and gives modals and the palette a graceful enter and exit.

## Background: current state (recon-confirmed)

No external animation library. Pure CSS `@keyframes` plus Tailwind utilities. Motion is gated globally: `motionPreference` (`system` / `full` / `reduced`, persisted as `fluux-motion`) resolves to a `data-motion` attribute on `<html>` (set in `useTheme.ts`), and a rule in `index.css` collapses every animation and transition to near-zero when reduced, with a `prefers-reduced-motion` fallback for the pre-JS window.

Durations today are scattered: 150ms (sidebar view fade), 200ms (toast, collapsible, color transitions), 220ms (occupant drawer), 250ms (button exit), 300ms (message send, keyboard-nav bounce), 400ms (button enter), 450ms (reaction burst), 1500ms (reply-highlight flash). Easings vary: `ease-out` (most), `ease-in` (button exit), `ease-in-out` (typing), `cubic-bezier(0.32, 0.72, 0, 1)` (drawer), `cubic-bezier(0.34, 1.56, 0.64, 1)` (button spring).

Modals use a shared `ModalShell` (about 18 dialogs) plus four standalone surfaces (`CommandPalette`, `ConfirmDialog`, `BackupPassphraseDialog`, `AvatarCropModal`). `ModalShell` is conditionally mounted by its parent (`{isOpen && <Modal/>}`) and renders both the scrim (`.modal-scrim`) and the glass panel (`.fluux-glass`). None of these animate in or out. `BottomSheet` already animates (`sheet-up`) and is left alone.

## Design

### 1. Motion token vocabulary

A small named scale, global (motion is not themed, so the tokens live in `:root` only with no per-theme overrides), defined in two coordinated layers.

CSS custom properties in `index.css` `:root`:

- `--fluux-duration-fast: 150ms`
- `--fluux-duration-base: 200ms`
- `--fluux-duration-slow: 300ms`
- `--fluux-ease-standard: ease-out` (the decelerating default that most animations already use; kept as `ease-out` so migration does not change feel)
- `--fluux-ease-emphasized: cubic-bezier(0.32, 0.72, 0, 1)` (the drawer's snappy decelerate, reused for modal panels)
- `--fluux-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)` (the scroll-button overshoot)

Tailwind config (`tailwind.config.js`) extension so the same vocabulary is usable as utilities:

- `transitionDuration`: `{ fast: 'var(--fluux-duration-fast)', base: 'var(--fluux-duration-base)', slow: 'var(--fluux-duration-slow)' }` yields `duration-fast` / `duration-base` / `duration-slow`.
- `transitionTimingFunction`: `{ standard: 'var(--fluux-ease-standard)', emphasized: 'var(--fluux-ease-emphasized)', spring: 'var(--fluux-ease-spring)' }` yields `ease-standard` / `ease-emphasized` / `ease-spring`.
- The existing custom `animation` shorthands (`tooltip-in`, `toast-in`, `sheet-up`) are rewritten to reference the duration and easing vars instead of literals.

### Migration map (feel-preserving)

The migration changes no durations. Every generic value already equals a token, and every bespoke animation keeps its tuned duration and only adopts the named easing token.

- Generic, maps fully onto tokens at the same value: `sidebar-view-enter` (150 to `fast` + `standard`), `toast-in` and collapsible height (200 to `base` + `standard`), `message-send` and keyboard bounce (300 to `slow` + `standard`), and the app-wide Tailwind `transition-colors` / `transition-opacity` usages (adopt `duration-base ease-standard` where a class is already being touched, not a blanket sweep).
- Bespoke, keeps its literal duration, adopts the easing token: occupant drawer (220ms, easing to `var(--fluux-ease-emphasized)`), scroll-button spring pair (400 / 250ms, enter easing to `var(--fluux-ease-spring)`), reaction burst (450ms, to `var(--fluux-ease-standard)`), reply-highlight flash (1500ms, unchanged, a deliberate one-off).

The result: three generic durations plus three easings form the vocabulary, used by generic transitions and the new modal work; bespoke animations share the easing names while keeping their tuned timing. Feel is identical to today.

### 2. Modal / dialog / command-palette enter-exit

Enter, centralized in `ModalShell` (covers all ~18 dialogs at once): the scrim fades in (opacity 0 to 1, `base`, `standard`); the panel scales and fades in (scale 0.97 to 1, opacity 0 to 1, `base`, `emphasized`). Pure CSS animation on mount.

Exit, symmetric: `ModalShell` gains a `closing` state. Any close trigger (Escape, the X button, a scrim click) sets `closing`, which swaps the panel and scrim to exit animations (panel scale 1 to 0.98 plus fade, scrim fade, `fast` duration), and then calls the real `onClose` after the exit duration so the parent unmounts on schedule. Two guards: a ref prevents a double-close from firing `onClose` twice, and when motion is reduced (`data-motion="reduced"` or `prefers-reduced-motion`) the delay is skipped and `onClose` fires immediately.

Shared hook: a small `useModalTransition` hook (in `apps/fluux/src/hooks/`) encapsulates the enter and exit class state, the `requestClose(onClose)` wrapper, the reduced-motion check, and the timing. `ModalShell` uses it, and the four standalone surfaces use it for identical behavior. `CommandPalette` adds a small downward `translateY` on enter (the familiar palette drop).

New keyframes (`modal-panel-in`, `modal-panel-out`, `scrim-in`, `scrim-out`) live in `index.css` and reference the duration and easing tokens. All of this respects the global `data-motion` gate automatically (CSS), and the JS exit delay respects it through the hook.

Interfaces (produced for the plan):

- `useModalTransition(): { panelClass: string; scrimClass: string; isClosing: boolean; requestClose: (onClose: () => void) => void }` (exact shape finalized in the plan).
- `ModalShell` keeps its existing props (`title`, `onClose`, `width`, `panelClassName`, `children`). The only behavior change is internal: `onClose` is invoked after the exit animation rather than synchronously.

### 3. Preserve

- The global `data-motion` and `motionPreference` system is unchanged; the new motion plugs into it.
- Existing animations keep their current feel: durations are unchanged, only easing references become tokens. Reaction burst, send animation, the spring button, drawer, typing dots, toast, and the highlight flash all look identical.
- `BottomSheet`'s `sheet-up` is left as-is.
- Modal behavior is preserved: the focus trap (`useRestoreFocus`), Escape-to-close, and scrim-click-to-close all still work. The exit only defers the unmount by the animation duration; focus restoration still fires because the panel stays mounted through the brief exit and then unmounts.

### 4. Risk to verify

`ModalShell` now calls `onClose` after the exit animation (the `fast` duration, 150ms) instead of synchronously. Almost every caller's `onClose` simply flips an `isOpen` state to unmount, which is fine deferred. The plan's verification checks the `onClose` callers for any that rely on a synchronous side effect (for example a save or navigation that must happen instantly); none is expected, but it is confirmed rather than assumed.

## Out of scope (deferred)

Presence-change pulses, skeleton and shimmer loaders, cross-view and route transitions, and list-item stagger (the remaining "not found" gaps). No animation library. No SDK changes. No retuning of existing durations or easings: feel is preserved, not redesigned.

## Theme-robustness

Motion tokens are global (`:root` only, no theme overrides). The modal enter and exit use transform and opacity, which are theme-independent; the panel and scrim colors come from the existing `.fluux-glass` and `.modal-scrim` tokens, which are already theme-correct. There is no per-theme motion work and no contrast implication, because motion here is transform and opacity, not color.

## Testing

Motion is transient and does not screenshot reliably, so the proof is unit tests.

- Token guard: `--fluux-duration-fast` / `-base` / `-slow` and `--fluux-ease-standard` / `-emphasized` / `-spring` are defined in `:root`, and the Tailwind config exposes the matching `duration-*` and `ease-*` utilities. A static assertion over `index.css` and `tailwind.config.js`.
- `ModalShell`: renders the enter classes on mount; a close action (Escape, X, scrim) routes through the delayed-exit path (`onClose` fires after the exit duration, not synchronously) when motion is full; fires `onClose` synchronously when motion is reduced; and never fires `onClose` twice on a double-close.
- `useModalTransition`: enter and exit class state, the `requestClose` timing (fake timers), the reduced-motion instant-close, and the double-close guard.
- Existing animation and modal tests stay green; any test that assumed a synchronous `ModalShell` `onClose` is updated.

Screenshots are optional. A modal mid-enter is not a stable capture, so the unit tests carry the proof; a resting-state (post-enter) screenshot is unchanged from today and adds nothing.
