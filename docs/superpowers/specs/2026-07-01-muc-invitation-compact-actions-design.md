# Compact adaptive actions for room invitation cards

**Date:** 2026-07-01
**Component:** `apps/fluux/src/components/sidebar-components/MucInvitationItem.tsx`

## Problem

The room ("Salons") invitation card in the sidebar is too large for the narrow
sidebar. It renders two full-width labeled buttons side by side — "Rejoindre"
(green) and "Refuser" (red) — indented under the room icon via `ms-13`. On a
narrow sidebar this action row is wider than the available space and makes the
card feel oversized.

The roster/contacts sidebar already solved the same problem for its action items
(`SubscriptionRequestItem`, `StrangerMessageItem`): a primary labeled button that
flexes, plus secondary icon-only buttons with tooltips. The invitation card
should adopt that established pattern.

## Scope

Single file: `MucInvitationItem.tsx`, action row only (current lines 38–54).

Out of scope: the card body (room icon, room name, "Invité par…" line, italic
reason) stays exactly as-is. No SDK, i18n, or other component changes.

## Design

Replace the action row with the compact hybrid layout used by
`SubscriptionRequestItem`:

- **Row wrapper:** `flex items-stretch gap-1.5 mt-2`. Drop the `ms-13` indent so
  the row spans the full card width (this is what gives it room to fit).
- **Join button (primary, keeps label):**
  `flex-1 min-w-0 px-2 py-1.5 bg-fluux-green text-white text-sm font-medium
  rounded hover:bg-fluux-green/80 transition-colors flex items-center
  justify-center gap-1`, containing `<Check className="size-4 flex-shrink-0" />`
  and `<span className="truncate">{t('events.join')}</span>`. The `flex-1
  min-w-0` + `truncate` combination is what makes the layout adaptive: the label
  ellipsizes gracefully as the sidebar narrows instead of overflowing.
- **Decline button (secondary, icon-only, muted grey):**
  `flex-shrink-0 px-2.5 py-1.5 bg-fluux-muted/20 text-fluux-text rounded
  hover:bg-fluux-muted/30 transition-colors flex items-center justify-center`,
  containing only `<X className="size-4" />`. Wrapped in
  `<Tooltip content={t('events.decline')} position="top">` and given
  `aria-label={t('events.decline')}` for accessibility.
- **Import:** add `import { Tooltip } from '../Tooltip'`. Keep the existing
  `Check, X, DoorOpen` icon imports.

Reuses existing translation keys `events.join` and `events.decline`.

## Design decisions

- **Decline is muted grey, not red.** Matches the roster reject button and
  de-emphasizes the negative action, so Join reads as the clear primary.
- **Join keeps its label; Decline is icon-only.** Mirrors the contacts/strangers
  views for cross-view consistency.
- **Adaptive, not fixed.** `flex-1 min-w-0` + `truncate` on Join and
  `flex-shrink-0` on Decline let the row shrink to fit any sidebar width.

## Verification

- Demo mode (`npm run dev` → `/demo.html`): confirm the "Salons" invitation card
  renders the labeled Join button + muted icon Decline, tooltip on hover, and
  fits within a narrowed sidebar without overflow.
- `npm run typecheck` and lint pass.
- Update the `MucInvitationItem` component test if one exists (assert the icon
  Decline button carries its `aria-label`); otherwise no test change required.
