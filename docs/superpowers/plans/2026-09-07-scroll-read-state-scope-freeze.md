# Scroll / read-state scope freeze

Status: draft, not yet reviewed by Mickaël. Written from the outside by reading the
git history and `docs/superpowers/` since 2026-07-01, not from being inside the
implementation sessions. Every claim below should be checked against what actually
shipped before this is trusted as ground truth.

## Why this file exists

Since 2026-07-01, 94 of 552 commits (17%) touch scroll / MAM / read-state / catch-up.
`scripts/scroll-invariants.ts` started (2026-06-25 header) as "encode the 6 acceptance
invariants" for Phase 1 of the virtualization rework. It now holds 58 test cases;
invariant 14 alone has fractured into 12 sub-cases (14, 14b–14l) as new edge cases kept
surfacing. In parallel, `docs/superpowers/plans/` shows the read-state model itself was
redesigned across at least four sequential stages between 2026-07-22 and 2026-07-28
(pointer-object → unread-count derivation → room-store canonicalization → writer
restriction → model consolidation), and the anomaly-detection log went through staged
design work from 2026-07-29 to 2026-09-01 (stages 0, 1, 3, 5a, 5b, 5c, 5d).

That process mostly shows good discipline, not runaway drift: stage 5d explicitly
records Task 2 ("the detector") as **withdrawn**, with a link to the design decision
that says why, rather than building it anyway. The plan/spec/checklist format this
project already uses (`docs/superpowers/plans/*.md` + `specs/*.md`, each with a
Files/Interfaces/Steps/Self-review structure) is a real definition-of-done mechanism —
when it's used.

**Correction (2026-09-07, after Mickaël flagged it): the paragraph below was wrong.**
The `docs/superpowers/` folder stopped getting new dated plan/spec files after
2026-09-01 not because discipline lapsed, but because the project switched from the
Superpowers skill to a different toolchain (`firstmate` / `no-mistakes`). That
toolchain documents differently — not one dated file per task, but two living,
continuously-updated references: `docs/ANOMALY_INVARIANTS.md` (a detector registry,
last touched today) and `docs/2026-07-23-scroll-positioning-contract.md` (a 41KB
contract doc whose 25-item migration checklist is now fully checked off). Both
`#1362` and `#1374` ARE documented there — in more depth than most of the earlier
Superpowers plans, including explicit severity levels (`bug` vs `suspect`) and
"named non-cases" sections that record exactly which similar-looking situations do
NOT trigger the detector and why, so a later reader doesn't have to re-derive it.
So: no undocumented gap, no process regression. What changed is only the artifact
shape, and nobody updated the parts of this repo (like the now-idle
`docs/superpowers/plans/` folder) that assumed the old shape would continue.

## The frozen contract (as of 2026-09-07)

Treat the following as **closed** unless a specific regression is reported against
them. Do not touch the underlying mechanism to "improve" it further without a plan
doc first:

- The 58 invariants currently in `scripts/scroll-invariants.ts` (`npm run test:scroll`
  green on both `scroll-chromium` and `scroll-webkit`).
- The read-state model as consolidated per
  `docs/superpowers/specs/2026-07-22-read-state-model-consolidation-design.md` and the
  stage A/B/B0/C plans that preceded it.
- Anomaly-log stages 0, 1, 3, 5a, 5b, 5c, 5d, **including** the withdrawn Task 2
  detector in stage 5d — do not resurrect it without reopening
  `docs/superpowers/specs/2026-07-29-client-anomaly-detection-log-design.md` §5.1.

## Open items needing a decision

1. `docs/superpowers/plans/` and `specs/` are now a dead end for anything past
   2026-09-01 — they describe real history but a reader (human or AI) landing there
   first will miss that `ANOMALY_INVARIANTS.md` and `scroll-positioning-contract.md`
   are the current source of truth for this area. Worth a one-line pointer at the top
   of the superpowers folder (or its removal from `AGENTS.md`/`CLAUDE.md` if it's no
   longer read by anything) so the next session doesn't have to rediscover this the
   way I just did.
2. Nothing else here needs retroactive work — the two recent detectors are already
   documented to a high standard.

## Going-forward rule

No change under `apps/fluux/src/components/conversation/`, `packages/fluux-sdk/src/stores/{room,chat}Store.ts`,
or `apps/fluux/src/anomaly/` ships without updating whichever of `ANOMALY_INVARIANTS.md`
/ `scroll-positioning-contract.md` covers it, in the same rigor those already have
(severity, meaning, what-to-do, named non-cases). If a session can't state the
detector/invariant it's closing up front, the work isn't scoped yet and shouldn't start.
