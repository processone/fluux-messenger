# Conformance across implementations

Status: proposed harness design. No runner or executable conformance suite is
provided by this documentation change.

## Authority and evidence

A readable contract explains the rule. Shared scenarios make selected consequences
testable. A language-specific adapter runs those scenarios against the actual
implementation and exposes observations at the specified boundary.

An adapter must not reproduce the lifecycle state machine, deduplication logic, or
other behavior being tested. It translates inputs and observations. Otherwise,
agreement would demonstrate that adapters match while leaving the libraries untested.

The existing TypeScript SDK is a source of candidate cases, not a correctness
oracle. Differential testing between implementations can discover discrepancies;
agreement alone does not prove that either implementation follows XMPP or Fluux policy.

## Proposed portable boundary

Use versioned JSON scenarios and a headless runner for each implementation. The
runner accepts a scenario and returns normalized observations plus a result. CLI
launch details can differ by toolchain; the scenario semantics must agree.

A scenario declares its contract revision, capabilities, initial environment,
ordered input steps, expected observations, forbidden effects, and final state.
Time and identifiers are explicit test inputs. Future wire scenarios also carry
XML fragments and fragmentation schedules, including invalid input.

The fake environment controls monotonic time, timer delivery, random values,
network outcomes, storage outcomes, and lifecycle signals. Inputs are delivered
through real implementation boundaries. A checkpoint drains immediately runnable
work without advancing time or supplying missing external input. If the runner
cannot reach a checkpoint within its work limit, it reports failure or a harness
error instead of guessing that nothing will happen.

## Example: a superseded attempt cannot become online

This illustrative JSON describes `CONN-001` from
[FX-CONNECTION](connection-lifecycle.md). It is a format proposal, not an existing
runner command or a claim that the scenario has passed.

```json
{
  "format": "fluux-scenario/0.1-draft",
  "id": "CONN-001",
  "contract": "FX-CONNECTION/0.1-draft",
  "requirements": ["FX-CONNECTION-001", "FX-CONNECTION-002", "FX-CONNECTION-003"],
  "environment": {"monotonicMs": 0, "connectDeadlineMs": 5000},
  "steps": [
    {"command": "connect", "attempt": "A"},
    {"command": "connect", "attempt": "B"},
    {"inject": "sessionReady", "attempt": "A", "session": "old", "transport": "late-A"},
    {
      "checkpoint": "late-result",
      "expectState": {"phase": "connecting", "attempt": "B"},
      "expectConnectOutcomes": [{"attempt": "A", "outcome": "superseded"}],
      "expectEffects": [{"kind": "closeTransport", "attempt": "A", "transport": "late-A"}],
      "forbidEvents": [{"kind": "sessionReady", "attempt": "A"}]
    },
    {"inject": "sessionReady", "attempt": "B", "session": "new", "transport": "current-B"},
    {
      "checkpoint": "current-result",
      "expectState": {"phase": "online", "attempt": "B", "session": "new"},
      "expectConnectOutcomes": [
        {"attempt": "A", "outcome": "superseded"},
        {"attempt": "B", "outcome": "ready", "session": "new"}
      ],
      "expectEvents": [{"kind": "sessionReady", "attempt": "B"}],
      "forbidEvents": [{"kind": "sessionReady", "attempt": "A"}]
    }
  ]
}
```

For this proposed format, each checkpoint examines the cumulative trace since the
start of the scenario. `expectState` matches the complete public lifecycle snapshot;
`expectConnectOutcomes` matches the complete ordered list of settled connect results.
`expectEffects` and `expectEvents` require at least one matching observation;
`forbidEvents` prohibits any matching event. A pattern matches all fields it names.
Exact event counts and ordering constraints need explicit additional predicates
when translating the other scenarios into this format.

The fake environment creates `late-A` only when injecting A's completion. Closing
an earlier resource during cancellation therefore cannot satisfy this assertion.

When executed, this example would check that closure was requested for A. It
would not prove production resource disposal, enforcement of a cleanup deadline,
or interoperability.

## Comparing observations

Normalize opaque identifiers by consistent renaming, preserving equality, scope,
and relationships. Do not delete identity fields or normalize away ordering,
duplicate events, error classes, or forbidden side effects. Compare XML by the
specified namespace-aware semantics; retain byte-level comparisons when a framing
or cryptographic requirement depends on exact bytes.

Requirements define which events must be ordered, which may commute, and which
effects are forbidden. Do not demand identical diagnostic logs or internal task
scheduling. Test platform-specific capabilities under named profiles, rather than
quietly skipping required behavior on one implementation.

## Layers of verification

1. **Portable contract scenarios:** deterministic success, failure, cancellation,
   duplicate, and reordered-input cases against the real library.
2. **Boundary checks:** adversarial XML, parser fragmentation, resource bounds,
   transport and storage adapter behavior, and language concurrency checks.
3. **Interoperability:** real wire exchanges with ejabberd and at least one other
   independently implemented server for each claimed protocol profile.
4. **Device integration:** actual platform storage, credentials, networking,
   suspension, process termination, and recovery.

Passing a layer establishes only its tested scope. Simulator success does not
establish background delivery or battery behavior on physical devices.

For each new invariant, introduce a targeted violating mutation and show that its
scenario fails for the intended reason. Restore the correct behavior and rerun.
An independent expected result and a positive control prevent a test from passing
because the implementation does nothing or the adapter silently filters failures.

## Revision and result records

Each result identifies the contract revision and content digest, scenario revision
and digest, implementation commit and source-tree digest, adapter revision,
dependency/toolchain versions, environment, capabilities, and invocation. A dirty
worktree needs a recorded content snapshot; a commit identifier alone is insufficient.

Report each case as passed, failed, unsupported, not run, or harness error. An
implementation can claim a capability only when all its required cases pass under
the specified profile. Track missing cases separately from successful tests.

Changing a requirement or scenario invalidates the affected evidence. Editing
expected results to match one implementation is a contract change requiring review,
not a routine test repair. No current implementation has a result record for this
draft set.
