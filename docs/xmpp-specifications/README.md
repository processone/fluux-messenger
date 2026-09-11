# Common specifications for the Fluux XMPP libraries

Status: initial design draft. Direction recorded on 2026-09-11; detailed contracts
are proposed and have no implementation or conformance evidence yet.

## Direction

Build new XMPP libraries from common, language-independent specifications. The
initial implementations are TypeScript for web, Swift for iOS, and Kotlin for
Android. Native Windows is the final target to add, after those three targets.
Their protocol behavior is designed together; their language APIs and platform
integration can differ.

The specifications are the source of intended behavior. Existing Fluux code and
other XMPP implementations provide examples, interoperability cases, and lessons
about failures. They do not define correctness merely by exhibiting a behavior.

The protocol implementations will be new. Platform TLS, credential storage, XML
parsing, cryptographic primitives, and other suitable foundational components can
be reused behind specified interfaces. A shared native runtime is not a prerequisite.

These documents describe a new library family. They do not change the current
SDK, select migration dates, or claim compatibility with its public API or storage.

## Target sequencing

Develop the common specifications and conformance approach for the initial web,
iOS, and Android implementations. Their relative implementation order remains
open. Add native Windows last, using the same contracts and scenario corpus.

Keep the shared design independent of those first three runtimes so Windows can
implement it without redefining protocol behavior. C#/.NET is the proposed Windows
implementation language; its platform adapters and public API will be specified
when that target is developed. Windows-specific implementation work is deferred.

## Contents

- [Connection lifecycle](connection-lifecycle.md): first bounded contract,
  covering ownership, cancellation, and late asynchronous completions.
- [Conformance](conformance.md): portable scenarios, observation boundaries, and
  the evidence required to claim implementation of a contract.

## Architectural boundaries

The design has three layers with separately identifiable requirements:

1. **Protocol core.** Addresses, stream parsing and framing, negotiation,
   authentication, stanza exchange, request correlation, and connection lifecycle.
2. **Protocol extensions.** Individually specified XEP modules, with explicit
   dependencies, advertised capabilities, failure behavior, and interactions.
3. **Headless messaging model.** Message reconciliation, history coverage, read
   state, and notification eligibility. These are Fluux policies built on protocol
   facts; they are not all guarantees supplied by XMPP itself.

The UI consumes commands, state, and events from the headless model. It does not
own protocol sequencing. A bot can use the protocol layers without adopting
Fluux's conversation model.

Each mutable domain has one declared owner. Modules request work or emit facts
across boundaries; they do not silently mutate another module's state. The design
specifies ordering, cancellation, and observable results without requiring the
same classes, threads, actors, stores, or async API in every language.

## Common behavior and platform variation

The common contract defines meanings, constraints, and failure outcomes. Platform
adapters provide transport, clocks, scheduling, randomness, storage, credentials,
and lifecycle observations. Each adapter needs its own contract and integration
checks; a test adapter passing does not establish production adapter correctness.

Browser WebSocket transport and native TCP transport have different framing and
capabilities. Their profiles must be explicit. Suspension and process termination
are inputs the library must recover from under a defined policy, not promises of
unrestricted background execution.

Language APIs may use promises and subscriptions, Swift concurrency, or Kotlin
coroutines. Their observable ordering and completion guarantees must agree.
Internal performance strategies may differ within the specified bounds.

## Specification rules

Every contract identifies:

- Its stable identifier, revision, status, scope, and dependencies.
- Referenced RFC sections and exact XEP revisions or immutable source snapshots.
- Inputs, outputs, state ownership, preconditions, and invariants.
- Success, cancellation, timeout, malformed input, and unsupported-capability cases.
- Ordering, resource limits, persistence, and restart semantics where relevant.
- Portable scenarios, implementation evidence, and unresolved decisions.

Distinguish **standard requirements**, **Fluux policy**, and **platform constraints**.
A Fluux policy may choose among allowed behaviors but cannot silently override a
standard. Conflicts or ambiguities become explicit decisions with rationale.

Use `draft` for work in progress, `accepted` for a reviewed contract revision, and
`superseded` for a revision replaced by another. Editing an accepted requirement
creates a new revision and invalidates the affected evidence. An implementation
report names the exact specification and scenario revisions it tested.

## Specification catalogue

The following is a work catalogue, not a promise of first-release feature parity:

| Area | Required design work | Status |
| --- | --- | --- |
| Lifecycle ownership | Attempts, cancellation, late results, session identity | First draft in this directory |
| Address model | RFC 7622 parsing, normalization, comparison, invalid input | Unspecified |
| XML and framing | Namespaces, incremental input, limits, TCP/WebSocket profiles | Unspecified |
| Transport and negotiation | Discovery, TLS, authentication, binding, downgrade rules | Unspecified |
| Stanza exchange | IQ correlation, deadlines, sender validation, backpressure | Unspecified |
| Stream management | Acknowledgements, counters, replay, resumption failure | Unspecified |
| Extension modules | Feature profiles, dependency and interaction rules | Unspecified |
| Messaging model | Identity, MAM/carbon reconciliation, read state, notification policy | Unspecified |
| Persistence and encryption | Transactions, crash recovery, trust and key lifecycle | Unspecified |
| Delivery to existing users | Public API, data and account migration requirements | Unspecified |

The existing [supported XEP inventory](../../SUPPORTED_XEPS.md) is an input for
requirements discovery. Its implementation labels do not apply to the new libraries.

## First implementation milestone

Refine the lifecycle contract and portable scenarios, then build a headless runner
for one new implementation. Implement the same bounded contract in a second
language to expose accidental assumptions in the specification and test adapter.
Review real failures and strengthen the contract before expanding feature scope.

Choose the first implementation language separately. A successful lifecycle test
does not establish a working XMPP client: wire negotiation, transport integration,
stream management, and interoperability each require their own specifications and
proof. No library currently claims conformance to this draft.

## Protocol references

These are discovery references, not a frozen conformance baseline. Record exact
sections and revisions when drafting each wire-level contract.

- [RFC 6120: XMPP Core](https://www.rfc-editor.org/rfc/rfc6120.html)
- [RFC 7395: XMPP over WebSocket](https://www.rfc-editor.org/rfc/rfc7395.html)
- [RFC 7622: XMPP Address Format](https://www.rfc-editor.org/rfc/rfc7622.html)
- [XEP-0198: Stream Management](https://xmpp.org/extensions/xep-0198.html)
