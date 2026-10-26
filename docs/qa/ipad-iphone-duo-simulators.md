# iPad and iPhone Duo simulator checks

## Scope

FLM-50 requests testing Fluux on an iPad simulator and on **iPhone Duo**.
The requested Duo target is the simulator named iPhone Duo, not two devices
running together and not iPad Split View or Stage Manager.

These checks exercise the real native shell with the project's isolated demo
(`net.processone.fluux.demo`). The demo uses the existing conversation fixtures;
its sends are local simulation, not XMPP delivery. No account, production data,
personal signing identity or remote notification service is needed.

This is a simulator interface check, not release qualification. Physical-device
keyboard/touch behavior, fold hardware, networking, encryption, push delivery
and cross-device synchronization remain outside its scope. See
[platform qualification](../PLATFORM_REGRESSIONS.md) for those boundaries.

## Environment and reproduction

Use the [native demo launcher](../IOS_DEVELOPMENT.md#run-the-isolated-demo).
Keep the Mac unlocked. Check for existing builds, test runners and booted
simulators before starting; let an existing heavy job finish. Run only one
heavy job and one simulator at a time. Stop the first simulator before starting
the second. Do not reuse a simulator containing a real account.

Planned targets:

- iPad Pro 11-inch (M5), iOS Simulator 27.0.
- iPhone Duo, iOS Simulator 27.1.

Build from a clean committed checkout, record the source commit with the build
log, and use the same embedded demo on both targets. Do not substitute a desktop
browser at the same viewport for native simulator evidence.

## Scenarios

| Scenario | Actions | Observations to retain |
| --- | --- | --- |
| iPad interface | Open a conversation; navigate to another conversation and settings; rotate portrait/landscape | Native screenshots, accessibility tree, visible and reachable controls, any clipping or overlap |
| iPhone Duo interface | Repeat navigation and rotation; inspect the screen modes actually exposed by Simulator | Actual display geometry, native screenshots, any unsupported mode or defect |
| Composer and lifecycle, each target | Focus the composer; enter and locally send a unique demo message; dismiss the software keyboard; background and foreground the app | Keyboard/composer visibility, a single local message, a usable returning view; recording for transitions |

For each failure, record the target, source provenance, steps, expected result,
actual result and the smallest evidence that shows it. Keep test artifacts
outside the project. File reproducible product defects separately after checking
for an existing task; do not repair them as part of this testing-only change.

## Results

Not run yet. A result must distinguish observed behavior from missing proof and
must not treat a successful build as a successful application journey.
