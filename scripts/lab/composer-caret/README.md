# Packaged macOS composer caret regression

This journey tests the native caret, not just DOM focus. On macOS, an empty room
editor with no background paint can retain focus, its ring and a collapsed DOM
selection without drawing a caret. A standalone browser does not reproduce that
packaged WKWebView behavior reliably. The direct-chat textarea is the control.

## Run

Requires macOS, the project's locked dependencies, Rust, Swift, Python 3 and
Pillow. Build from a clean, committed working copy. Keep both output directories
outside the project; native build output is large. Coordinate the build's CPU and
memory use with other native builds.

```sh
bash scripts/lab/composer-caret/build.sh "$BUILD_DIR"
python3 scripts/lab/composer-caret/run.py "$BUILD_DIR" "$RESULTS_DIR"
# Also check typing and clearing without refocusing:
python3 scripts/lab/composer-caret/run.py "$BUILD_DIR" "$OTHER_RESULTS_DIR" --type-clear
```

The run **takes the front window and moves the pointer**. The optional check
also types one unsent `x` and Backspace. Obtain approval for that screen and
keyboard use first. Screen Recording and Accessibility/event-posting access must
already be available; the harness never requests or changes permissions.

The app is the existing startup-recovery lab: a separate bundle identity,
disposable HOME, in-memory secrets, no notifications and no updater. It loads
packaged demo assets, never an installed account. The observer accepts commands
only from the expected lab configuration directory and packaged demo origin.
It clears only the two measured sample drafts before they are opened. It does
not change focus, selection, text or paint during a measurement. The runner
requires the unmodified native startup gate to reach `Open` before input.

Each run has a 90-second bound, stops only its own executable, and removes its
profile in `finally`, including on interruption. Do not force-kill the runner;
use its normal termination signal so cleanup can finish. It refuses an existing
profile or app rather than deleting or stopping one it did not start.

## What the test owns

- **Intent:** a focused composer shows its real caret, including when empty.
- **Fixture:** the packaged sample Design Review room and Emma Wilson direct chat,
  native single clicks, and optional native character insertion/deletion.
- **Failure:** zero caret-on frames during a valid 2–3-second interval. Loss of
  native/editor focus, an incomplete interval or unexpected fixture text fails
  separately; none counts as a caret pass.
- **Layer:** native window pixels, the cheapest layer that sees the packaged
  paint defect. Browser geometry and unit tests cannot establish this fact.
- **Owner:** this lab owns the native pixel assertion. Existing composer browser
  journeys own wrapping, scrolling, mention editing and text/caret geometry.
- **Gate:** run this native journey when room-editor rendering or its native
  host changes. It requires a visible desktop and permission-dependent probes,
  so it is not a deterministic headless check on every branch. Keep the existing
  branch checks, composer browser journeys and release qualification gates.

`source.txt`, `samples.json`, input/focus traces, native startup logs and window
pictures stay in the results directory. The runner compares the entire editor
crop against a no-caret reference captured **after** observation. A vertical
pixel run of at least eight CSS pixels identifies a caret-on frame; blink-off
frames are expected. The direct control must also paint. Nothing is sent to a
server and no draft is submitted.
