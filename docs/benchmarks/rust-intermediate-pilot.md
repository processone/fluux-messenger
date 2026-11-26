# Unsigned Linux Rust intermediate-cache pilot

This is an evaluation lane, not a new default. It changes only how the unsigned
Linux desktop binary is built and checked. It does not change check selection,
skip native tests, configure a global Cargo target, install a compiler wrapper,
or build a signed application. Do not roll it out until the criteria below pass.

## Scope and isolation

Use only mutually trusted local Fluux checkouts on the pilot Linux host, with
Cargo 1.100 or later and the existing native build prerequisites. The opt-in
runner requires Node.js, `flock`, `dpkg-query`, the host compiler/linker,
`pkg-config` and the load-line launcher supplied by the local work scheduler.
There is no default cache path or machine-wide environment change. Ordinary
JavaScript policy tests use recorded real tool identities and require none of
these native tools.

The runner accepts only `cargo build --bin fluux` and `cargo test --bin fluux`,
using the locked offline dependency graph, two workers and the explicit `dev`
profile. Both commands explicitly pass the compiler's resolved host target;
Cargo configuration cannot silently select another platform. `--features`
supports an explicitly qualified variant. No arbitrary arguments are forwarded.
Do not substitute `--lib`: the mobile library excludes its implementation on
Linux and is not evidence of a desktop build or nonempty desktop test suite.

Final desktop executables live in an explicit private output directory outside
the cache. Before releasing the cache lock, the runner replaces Cargo's published
hard link with independent executable storage and records both file identities.
Both lanes reject redirected descendants of the output root before Cargo starts.
Builds retain only compatible registry dependency units; the runner removes all
checkout-sensitive units and incremental state before and after every shared
build. Even an older checkout must regenerate its own native code, build-script
values and embedded Git version. A warm repeat therefore still rebuilds local
units. Tests seed an empty private intermediate directory with compatible
registry units only: no workspace crates, incremental state or test executables
are copied.
Cargo checks those dependency fingerprints normally. The supported Cargo layout
is `debug/build/<package>/<unit>/{fingerprint,out,run}`, with a host-target prefix
where applicable. Copying no recognized unit is an isolated fallback, not a seed
hit. Reports record copied units and match them against Cargo's actual `Fresh`
artifact messages; a seeded test run without a matching dependency hit fails.
The shared dependency files remain stable and locked while the test build uses
their build-script outputs. Source timestamps are never rewritten; copied
intermediate files retain their existing metadata. The configured test runner refuses execution outside private outputs,
requires a nonempty native test inventory and records the executable path and
inventory before running it. Private outputs and their cleanup belong to the
caller. Existing complete native and platform gates still run outside this lane.

A compatibility key separates features, explicit development profile, host
target, Cargo/rustc identities, actual compiler/linker binaries, native SDK
headers and resolved shared libraries, Rust standard libraries, installed system
packages, tracked Cargo manifests/lockfiles and build environment variables.
Both reused and private comparison lanes qualify and pin identical Rust/C/C++
tools and the host linker. Each report records tool identities, an SDK digest
and `qualification.comparisonKey`; paired timing and freshness runs must have
matching qualified identities. Explicit private controls prepare these identities
outside the measured build; reused lanes qualify under the timed cache lock.
Unknown compiler, linker, wrapper, SDK/search-path
overrides and nonempty checkout/ancestor/Cargo-home configuration use isolated,
unqualified settings instead of a guessed key and cannot count as a comparison.
This includes plain, host/target-prefixed and target-suffixed `PKG_CONFIG`
overrides supported by the native dependencies.
Native source freshness remains Cargo's responsibility. Neither timestamps nor
fingerprints are rewritten. Conservative qualification may miss reuse on purpose.

The whole build/test first enters the load line, then holds one exclusive lock,
including seeding and eviction. This serializes different keys too. Admission,
lock wait and compatibility inspection are included in elapsed time. Use one
cache parent for the lane; different roots do not coordinate reuse.

Only private account-owned directories without redirected components are
accepted. The runner creates a marked `fluux-rust-pilot-v2` namespace beneath
the supplied parent. Eviction touches only entries there; unrelated parent files
are never candidates. Control files must be owned regular files without hard
links. Redirected locks, entries, markers or intermediate trees disable reuse.

Setup/key/lock failures before Cargo starts fall back to private intermediates.
A per-invocation worker receipt distinguishes a failed lock launch from a Cargo
failure and records the actual lane: `shared`, `private-seeded`, `private` or
`not-started`. A compiler/test failure is returned unchanged, never retried as a
cache miss. After Cargo completes, receipt-publication errors still trigger
registry-only cleanup and pruning under the lock. Cleanup and publication errors
fail an otherwise successful run without replacing an existing Cargo failure.
The parent preserves the scheduler's known failure even if a final receipt is
partial/unreadable or the optional report cannot be published.

## Bounds

Before and after shared access, remove entries individually larger than 10 GiB
and entries unused for seven days. Then evict least-recently-used fitting entries
until retained intermediates occupy at most 10 GiB. An oversized newest entry
cannot evict smaller reusable entries first. Size counts logical file and
directory bytes; redirected entries are rejected before deletion. The active
build can temporarily exceed the retained limit and is removed afterward if
oversized. This is a retention cap, not a filesystem quota. Idle eviction happens
on the next invocation; no background cleanup job is installed. The namespace's
lock and ownership marker are never evicted.

## Invocation

Provide absolute paths in `PRIVATE_OUTPUT`, `PILOT_CACHE` and `RUN_REPORT` for
private outputs, a trusted private cache parent outside disposable checkouts,
and evidence respectively. The report parent must be an existing owned directory
without aliases or redirects. The report must be outside both outputs and cache, including nested
paths. Reports publish through a new file and atomic replacement, so an existing
hard link cannot overwrite another output or cached file:

```sh
# Private cold comparison; no cache access.
node scripts/rust-build-pilot.mjs --target "$PRIVATE_OUTPUT" --report "$RUN_REPORT"

# Candidate shared build; still no global Cargo setting.
node scripts/rust-build-pilot.mjs --shared --cache "$PILOT_CACHE" \
  --target "$PRIVATE_OUTPUT" --report "$RUN_REPORT"

# Actual desktop native tests, with a private executed binary.
node scripts/rust-build-pilot.mjs --shared --cache "$PILOT_CACHE" \
  --target "$PRIVATE_OUTPUT" --operation test --report "$RUN_REPORT"
```

Save stdout/stderr as well as the JSON report. `wallMs` measures runner setup
through receipt/output checks, including admission and lock wait. For explicitly
private controls, `preparationMs` records the separate identity-qualification
phase; `elapsedMs` subtracts only that phase so unused cache hashing cannot inflate
the cold baseline. The private worker uses the prepared identities and pinned
tools without repeating qualification. Requested reuse has zero excluded
preparation: all cache qualification, queueing, lock wait and fallback costs count.
Compare `elapsedMs`, not the cold command's total time including qualification.
The report records the lane actually used, copied-unit counts and matching `Fresh`
registry artifacts, not a claim that Cargo reused every crate. Count Cargo's
actual `Fresh`, `Compiling` and `Running` readings. Successful test
reports must include the nonempty inventory and private executable receipt.

## Evaluation and retention decision

1. Materialize independent source checkouts at one committed version, without
   copying targets or manipulating timestamps. Use the same offline registry,
   host environment and worker count throughout. Log the actual desktop target
   and require matching qualified tool identities, SDK digest and comparison key
   in every reused/clean pair, including the native freshness checks.
2. Interleave three empty private cold desktop builds and three fresh-copy shared
   desktop builds against one populated cache. Log the seed separately; it is
   not a cross-copy hit. Repeat the last shared build warm.
3. Compare actual desktop test inventories and outcomes with a clean build.
   Require a nonempty inventory and record the private executed path. Perturb
   Rust source, the native build script, its SDK timeout input and Tauri config.
   Compare reused and private clean results, generated timeout values and
   deliberate failures that must not become stale successes. In the shared build
   lane, build a newer copy before an older-mtime copy containing different native
   inputs and a different Git version. The older copy must match its clean build
   without changing source timestamps. Test seeding must demonstrate at least one
   dependency both copied from the registry cache and reported `Fresh` by Cargo.
4. Compare real feature and flag variants with clean builds. Confirm key changes,
   forced host target, effective compiler/linker/SDK identities, private final
   artifacts and serialized access. Exercise unavailable/redirected lock fallback,
   actual lane reporting, unrelated-file protection, idle eviction and
   oversized-entry-first removal. Compare executable device/inode/link readings
   with the shared original before releasing the lock, then show that another
   shared build cannot change the published executable. Exercise redirected
   intermediate, target and profile descendants before Cargo can write to them.
   Reject overlapping/redirected report paths before launch and prove that report
   publication cannot modify an existing linked output. Exercise receipt-write
   failure after a completed build and verify that cleanup still runs under the
   lock and the original Cargo failure status remains intact.
5. Retain reuse only if coverage is equivalent and the three cross-copy runs'
   median `elapsedMs`, including queueing, is at most 70% of the three cold
   runs' median. Otherwise remove the candidate lane and preserve the result,
   not an enabled optimization. Warm-repeat savings alone are insufficient.

Run `npm run test:rust-build-pilot` for deterministic key, retention, namespace
and output-separation safeguards. Linux branch and batch checks run them without
requiring native tools. They do not replace real Cargo comparisons. Existing
branch, batch, platform and release gates remain unchanged in scope.

## Reviewed result

The qualified unsigned Linux host experiment met the retention criteria. Keep
this lane opt-in; this result does not enable a default or qualify another host.
The registry was already available offline in both lanes.

| Paired run | Cold elapsed time | Fresh-copy elapsed time |
| --- | ---: | ---: |
| 1 | 630.08 s | 50.28 s |
| 2 | 230.01 s | 33.41 s |
| 3 | 208.97 s | 34.68 s |
| Median | 230.01 s | 34.68 s |

The median reduction was **84.92%**, including admission and lock wait. Each
fresh-copy build recorded 848 registry artifacts Cargo treated as fresh and
rebuilt 33 artifacts. The separate seed and 32.36-second warm repeat do not count
toward the threshold. Only explicit private qualification was excluded, as
specified above; requested reuse excluded no preparation. Compared tool and SDK
identities matched, and published executables had independent storage.

Clean and private-seeded original suites each passed 482 tests with the same four
pre-existing ignores and no filtering. Seeded tests executed a private binary
and recorded 832 copied registry units Cargo treated as fresh. Changed-input
suites each passed 483 tests, including a compiled-input observation. An older
checkout built after a newer one matched its clean build's Git marker, SDK
timeout and Tauri product name without rewriting source timestamps. Deliberate
Rust and build-script errors failed in both lanes as intended.

The comparison also demonstrated distinct feature/flag keys, kernel lock
exclusion, idle eviction, private fallback and native failure status preservation
through an unreadable receipt. Default 10 GiB aggregate and oversized-first
retention checks used hard-linked snapshots of real Cargo files, never consumed
by Cargo; they establish the logical retention policy, not a physical-disk quota.
Other report-error permutations used command-boundary stand-ins and are not
claimed as native runs. All disposable experiment outputs and control processes
were removed after preserving the evidence.

This result does not qualify packaging, installed-app behavior, production TLS
runtime, macOS or mobile. Existing platform and batch gates remain required.
