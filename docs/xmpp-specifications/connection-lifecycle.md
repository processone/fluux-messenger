# Connection lifecycle

- Contract: `FX-CONNECTION`
- Revision: `0.1-draft`
- Status: proposed Fluux policy; no implementation has been tested against it.

## Scope

Define which connection attempt may affect a client instance, and how cancellation
interacts with late asynchronous results. This is a lifecycle contract above the
transport and negotiation interfaces. It does not specify their wire behavior,
authentication mechanisms, reconnection delays, or XEP-0198 replay rules.

The protocol boundary follows the responsibilities described by
[RFC 6120](https://www.rfc-editor.org/rfc/rfc6120.html). The ownership and cancellation
rules below are proposed Fluux policy, not additional requirements attributed to
that RFC.

## Terms and observation boundary

- **Client instance:** owner of one account's connection lifecycle. Its account
  identity cannot be changed; another account uses another instance.
- **Attempt:** one request to establish a usable session. Its opaque identifier
  is unique within the instance and accompanies all asynchronous work it starts.
- **Session:** a negotiated logical XMPP session. It has a separate identity from
  the attempt and transport. A future resumption contract may preserve session
  identity across replacement transports and attempts.
- **Current attempt:** the only attempt authorized to publish lifecycle changes.
- **Retired attempt:** a failed, cancelled, replaced, or disconnected attempt.
  Work it previously started may still finish, but no longer has authority.
- **Admission:** the point where the lifecycle owner accepts and orders an input.
  Concurrent callers observe the order established here, not wall-clock order.

The owner processes admitted inputs in one logical sequence. Implementations can
use different concurrency mechanisms. Required events, outcomes, and transport
effects must reflect that sequence. Attempt identifiers are distinct from message,
stream, and account identifiers.

## Abstract inputs and observations

Names below describe the test boundary, not mandated public method signatures.

| Input | Meaning |
| --- | --- |
| `connect(attempt)` | Start a new attempt; its account and configuration are already validated |
| `disconnect` | Withdraw permission to remain connected or automatically reconnect |
| `sessionReady(attempt, session, transport)` | Negotiation reports a usable session and transfers its identified transport resource to the owner |
| `attemptFailed(attempt, reason)` | Establishment failed, including an enforced deadline |
| `transportLost(attempt, reason)` | An established transport has become unusable |

`sessionReady` is a trusted test seam for a separately verified negotiation
component. A raw socket opening, a peer-supplied string, or an authentication
response alone cannot be substituted for it by a production adapter.

Observations comprise an `idle`, `connecting`, or `online` lifecycle snapshot;
ordered lifecycle events; operation outcomes; and requested transport effects.
An implementation may expose additional diagnostic phases internally.

## Proposed requirements

### FX-CONNECTION-001: one current attempt

Admitting `connect(B)` replaces any current attempt A. Retire A before starting B;
request cancellation of A's pending work and closure of its transport. A pending
connect A receives the outcome `superseded`. A previously successful connect A
keeps its completed result, while its online lifecycle ends with reason `replaced`.
The snapshot becomes `connecting(B)`.

### FX-CONNECTION-002: retirement revokes authority

After retirement, a result associated with A cannot change the current snapshot,
publish a session, schedule a reconnect, deliver application data, or write account
state. A transport resource returned late is closed. Retiring A cannot cancel or
close B's work or transport. Best-effort cancellation alone is insufficient:
results must be checked even if their producer ignores cancellation.

### FX-CONNECTION-003: bounded, single connect outcome

Each admitted connect settles once with `ready(session)`, `failed(reason)`,
`cancelled`, or `superseded`. The establishment deadline is a finite configuration
input, enforced by the owner using the injected clock. Its expiration is admitted
as an attempt failure; late completion is subject to requirement 002.

Processing `sessionReady` for the current connecting attempt establishes `online`,
settles the connect as ready, and publishes one session-ready event. A repeated
completion for the same attempt and session is ignored. Contradictory completions
are adapter violations; their additional resources are disposed without changing
the established session. Losing a session after success produces a lifecycle event
and does not retroactively reject or complete the connect operation again.

A duplicate completion naming the already-owned transport does not close that
transport. A distinct resource returned by a duplicate or retired completion is
disposed; attempt identity and resource identity must both be preserved.

### FX-CONNECTION-004: disconnect is a local barrier

Admitting `disconnect` retires the current attempt and cancels pending automatic
retry work. A pending connect settles as cancelled. Request transport closure,
publish a lifecycle change if needed, and expose `idle` with no current attempt.
Disconnect completes after this local invalidation and issuance of cleanup effects;
it does not claim that a peer observed a graceful stream close.

Late cleanup work remains owned by its retired attempt. It cannot publish new
application events or revive the connection. Repeated disconnect while idle is
idempotent. A later explicit connect can start a new attempt.

### FX-CONNECTION-005: failure and recovery are explicit

Failure of the current connecting attempt retires it and settles its connect as
failed. Loss of the current online transport retires its attempt and publishes one
session-ended event with the reason. Both leave the owner idle. The environment
can request a new connect; this draft adds no automatic retry policy.

A future retry module must use the same admission boundary, respect the disconnect
barrier, and attach authority to scheduled work so stale retries cannot restart an
instance. Retry, background suspension, and restart policies need separate contracts.

## Required scenarios

| Scenario | Inputs and required outcome | Requirements |
| --- | --- | --- |
| CONN-001 | A starts, B replaces A, A reports ready: B stays connecting; A's resource closes; A cannot publish ready | 001, 002, 003 |
| CONN-002 | A starts, disconnect completes, A reports ready: instance stays idle; no ready event or new attempt | 002, 003, 004 |
| CONN-003 | A becomes online, its transport is lost: one session-ended event; connect result remains successful | 003, 005 |
| CONN-004 | A starts, its deadline expires, A reports ready: failed outcome occurs once; late transport closes | 002, 003, 005 |
| CONN-005 | A becomes online; duplicate ready for A and the same session: no second connect outcome or ready event | 003 |
| CONN-006 | Disconnect twice from idle: no attempt, duplicate lifecycle change, or reconnect | 004 |
| CONN-007 | Two client instances use the same local attempt label; retire one: the other is unaffected | 001, 002 |
| CONN-008 | A is replaced by B; A reports failure after B becomes online: B remains online | 001, 002, 005 |

Scenarios must include the successful completion of B where applicable to ensure
an implementation cannot pass by suppressing all results. A deliberately removed
authority check must make the late-result scenario fail. See
[conformance](conformance.md) for the required adapter and evidence boundaries.

## Decisions still needed

- Confirm replacement semantics for concurrent connects versus rejecting a second
  connect as busy. Replacement is the proposal used by this draft's scenarios.
- Define the transport adapter's resource ownership and bounded cleanup contract,
  including handling a hung close operation.
- Specify production timeout defaults, error taxonomy, retry eligibility, and
  lifecycle handling during process suspension and restart.
- Specify session resumption and how it composes with this attempt lifecycle.
- Choose public APIs independently for TypeScript, Swift, and Kotlin, followed by
  the Windows implementation when that final target is developed.
