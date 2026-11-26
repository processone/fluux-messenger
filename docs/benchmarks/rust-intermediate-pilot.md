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
the cache. Builds reuse Cargo's intermediate directory. Tests instead seed an
empty private intermediate directory with compatible registry dependency files
only: no workspace crates, incremental state or test executables are copied.
Cargo checks those dependency fingerprints normally. The shared dependency
files remain stable and locked while the test build uses their build-script
outputs. The configured test runner refuses execution outside private outputs,
requires a nonempty native test inventory and records the executable path and
inventory before running it. Private outputs and their cleanup belong to the
caller. Existing complete native and platform gates still run outside this lane.

A compatibility key separates features, explicit development profile, host
target, Cargo/rustc identities, actual compiler/linker binaries, native SDK
headers and resolved shared libraries, Rust standard libraries, installed system
packages, tracked Cargo manifests/lockfiles and build environment variables.
The shared lane pins its identified host linker. Unknown compiler, linker,
wrapper, SDK/search-path overrides and nonempty checkout/ancestor/Cargo-home
configuration use the isolated lane instead of a guessed compatibility key.
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
cache miss. Cleanup failure fails the run instead of claiming bounded retention.

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
and evidence respectively:

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

Save stdout/stderr as well as the JSON report. The report measures from before
compatibility inspection until scheduler exit, including admission and lock wait.
It records the lane actually used, not a claim that Cargo reused every crate.
Count Cargo's actual `Fresh`, `Compiling` and `Running` readings. Successful test
reports must include the nonempty inventory and private executable receipt.

## Evaluation and retention decision

1. Materialize independent source checkouts at one committed version, without
   copying targets or manipulating timestamps. Use the same offline registry,
   host environment and worker count throughout. Log the actual desktop target.
2. Interleave three empty private cold desktop builds and three fresh-copy shared
   desktop builds against one populated cache. Log the seed separately; it is
   not a cross-copy hit. Repeat the last shared build warm.
3. Compare actual desktop test inventories and outcomes with a clean build.
   Require a nonempty inventory and record the private executed path. Perturb
   Rust source, the native build script, its SDK timeout input and Tauri config.
   Compare reused and private clean results, generated timeout values and
   deliberate failures that must not become stale successes.
4. Compare real feature and flag variants with clean builds. Confirm key changes,
   forced host target, effective compiler/linker/SDK identities, private final
   artifacts and serialized access. Exercise unavailable/redirected lock fallback,
   actual lane reporting, unrelated-file protection, idle eviction and
   oversized-entry-first removal.
5. Retain reuse only if coverage is equivalent and the three cross-copy runs'
   median elapsed time, including queueing, is at most 70% of the three cold
   runs' median. Otherwise remove the candidate lane and preserve the result,
   not an enabled optimization. Warm-repeat savings alone are insufficient.

Run `npm run test:rust-build-pilot` for deterministic key, retention, namespace
and output-separation safeguards. Linux branch and batch checks run them without
requiring native tools. They do not replace real Cargo comparisons. Existing
branch, batch, platform and release gates remain unchanged in scope.

No result is claimed yet. Independent review precedes live proof; reviewed timing
and freshness evidence determines whether the candidate is kept. Other operating
systems, packaging, production-TLS and application/device qualification are not
implied by this unsigned desktop experiment.
