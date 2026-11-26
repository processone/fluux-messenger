# Unsigned Linux Rust intermediate-cache pilot

This is an evaluation lane, not a new default. It changes only how a native host
library is built and checked. It does not change check selection, skip native
tests, configure a global Cargo target, install a compiler wrapper, or build a
signed application. Do not roll it out until the retention criteria below pass.

## Scope and isolation

Use only mutually trusted local Fluux checkouts on the pilot Linux host, with
Cargo 1.100 or later and the existing native build prerequisites. The runner
requires Node.js, `flock`, `dpkg-query`, the host compiler/linker and the load-line
launcher supplied by the local work scheduler. It is not a portable CI wrapper.
There is no default cache path or machine-wide environment change.

The runner accepts only `cargo build --lib` and `cargo test --lib`, using the
locked offline dependency graph, two workers and the development profile.
`--features` supports an explicitly qualified variant. No arbitrary Cargo
arguments are forwarded. Final outputs must be in an explicit private directory,
separate from the cache. Cargo's intermediate build directory alone is reused.
The private directory's lifetime belongs to the caller.

A compatibility key separates operation, feature list, profile, OS/architecture,
Cargo and rustc identity, compiler/linker versions, installed system-package
versions, tracked Cargo manifests/lockfiles/configuration, ancestor and Cargo-home
configuration, and native build environment variables. Native source freshness
remains Cargo's responsibility. Neither source timestamps nor fingerprints are
rewritten. This conservative key can miss reuse opportunities intentionally.

The whole build and test execution first enters the load line, then holds one
exclusive lock for the cache root, including eviction. This serializes different
keys as well as identical keys. Lock wait is included in elapsed time. Use one
root for the lane; different roots deliberately do not coordinate reuse.

Only cache directories owned by the current account, without group/other access
or symlink components, are accepted. Do not use an untrusted checkout or cache.
Setup/key inspection failure uses private intermediates instead. A compiler or
test failure is returned unchanged, never retried as a cache miss. A cleanup
failure also fails the run rather than claiming bounded retention.

## Bounds

Before and after each shared build, evict entries unused for seven days and then
least-recently-used entries until retained intermediate files occupy at most
10 GiB. Size counts directory entries and logical file bytes, including sparse
files; symlinks are counted, not followed. The active Cargo build can temporarily
grow beyond the retained limit. After it exits, an oversized active entry is
removed in full. This is a retention cap, not a filesystem quota. No background
cleanup job is installed: idle eviction happens on the next lane invocation.
The lock file is kept outside entry directories and is never evicted.

## Invocation

Choose absolute paths for a task-private output directory, a trusted private
cache directory outside all disposable checkouts, and evidence output. For
example, with those paths provided in `PRIVATE_OUTPUT`, `PILOT_CACHE` and
`RUN_REPORT`:

```sh
# Private cold comparison; no cache access.
node scripts/rust-build-pilot.mjs --target "$PRIVATE_OUTPUT" --report "$RUN_REPORT"

# Candidate shared lane; still no global Cargo setting.
node scripts/rust-build-pilot.mjs --shared --cache "$PILOT_CACHE" \
  --target "$PRIVATE_OUTPUT" --report "$RUN_REPORT"

# Execute the same complete native library test suite, not just compilation.
node scripts/rust-build-pilot.mjs --shared --cache "$PILOT_CACHE" \
  --target "$PRIVATE_OUTPUT" --operation test --report "$RUN_REPORT"
```

Save stdout/stderr as well as the JSON report. The latter measures from before
cache/key preparation until scheduler exit, including admission and lock wait.
The caller may additionally measure its complete command wall time. It records
whether shared reuse was requested successfully, not a claim that Cargo reused
every crate. Count Cargo's actual `Fresh`, `Compiling` and `Running` readings.

## Evaluation and retention decision

1. Materialize independent source checkouts at one committed version, without
   copying an existing target or manipulating source timestamps. Use the same
   offline registry, host environment and worker count throughout.
2. Interleave three empty private cold builds with three fresh-copy shared
   builds against one populated candidate cache. Record the seed separately;
   it is not a cross-copy hit. Repeat the last shared build warm.
3. Compare complete library test inventories and outcomes against a private
   clean build. Perturb actual Rust source, the native build script, the SDK
   timeout input read by that script, and Tauri configuration in disposable
   copies. Compare the changed-input checks with private clean builds,
   including deliberate failures that must not become stale successes.
4. Compare actual feature and compiler-flag variants with private clean builds.
   Confirm distinct keys, separate final artifacts, serialized execution,
   unavailable-cache fallback, aged-entry eviction and oversized-entry removal.
5. Retain reuse only if coverage is equivalent and the three cross-copy runs'
   median elapsed time, including queueing, is at most 70% of the three cold
   runs' median. Otherwise remove the candidate lane and preserve the result,
   not an enabled optimization. Warm-repeat savings alone are insufficient.

Run `npm run test:rust-build-pilot` for the deterministic key, retention and
output-separation safeguards. Both Linux branch and batch checks run them. These
unit checks do not substitute for the actual Cargo comparisons above. Existing
branch, batch, platform and release gates remain unchanged in scope.

No result is claimed yet. The evaluation must pass independent review before
its live runs; a reviewed timing and freshness record determines whether this
candidate is kept. Other operating systems, packaging, production-TLS coverage
and application/device qualification are not implied by this unsigned host
library experiment.
