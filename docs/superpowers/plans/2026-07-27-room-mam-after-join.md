# Room MAM After Confirmed Join Implementation Plan

This completed execution plan is intentionally not duplicated here. See the
[approved design](../specs/2026-07-27-room-mam-after-join-design.md) for the
change-specific invariants and [MAM catch-up strategy](../../MAM_CATCHUP.md) for
the shipped behavior.

Deterministic regression coverage lives in
`packages/fluux-sdk/src/core/roomSideEffects.test.ts` and
`packages/fluux-sdk/src/core/backgroundSync.test.ts`.
