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

**Select the iOS 27.1 runtime for iPhone Duo. iOS 27.0 is not sufficient:**
the Duo target is only available under 27.1. Check its runtime with
`xcrun simctl list devices available` and select its UUID rather than relying
on a device name shared by multiple runtimes. Do not create another Duo if the
requested device already exists.

Build from a clean committed checkout, record the source commit with the build
log, and use the same embedded demo on both targets. Do not substitute a desktop
browser at the same viewport for native simulator evidence.

## Scenarios

The requested iPad coverage includes **both portrait and landscape** for every
flow, not just an initial launch in each orientation. Repeat the complete iPad
checklist below in both orientations. Also exercise rotation while the app is
in use, in both directions, without relaunching or discarding the current state.

| Scenario | Actions | Observations to retain |
| --- | --- | --- |
| iPad navigation, portrait and landscape | Open a conversation; navigate to another conversation; scroll the conversation list; open settings and return | Native screenshots and accessibility tree for each orientation; visible and reachable controls; clipping or overlap |
| iPad rotation with an open conversation | Rotate portrait to landscape and back while a conversation is open | Selected conversation and usable message view after each transition |
| iPad rotation while typing | Start a draft with the software keyboard visible; rotate in both directions; continue typing and locally send | Draft retained; composer, keyboard and send control remain reachable; a single local message; transition recording |
| iPad rotation with a scrolled list | Scroll the conversation list; rotate in both directions without resetting it | Visible list position, selected conversation, reachable rows and scroll behavior before and after each rotation |
| iPad composer and lifecycle, portrait and landscape | Focus the composer; enter and locally send a unique demo message; dismiss the software keyboard; background and foreground the app | Keyboard/composer visibility and usable returning view in each orientation; a single local message |
| iPhone Duo interface | Repeat navigation and rotation; inspect the screen modes actually exposed by Simulator | Actual display geometry, native screenshots, any unsupported mode or defect |
| iPhone Duo composer and lifecycle | Focus the composer; enter and locally send a unique demo message; dismiss the software keyboard; background and foreground the app | Keyboard/composer visibility, a single local message, a usable returning view; recording for transitions |

For each failure, record the target, **orientation** (portrait or landscape),
rotation direction when relevant, source provenance, steps, expected result,
actual result and the smallest evidence that shows it. Log a problem separately
for each affected orientation rather than reporting a blanket device result.
Keep test artifacts outside the project. File reproducible product defects separately after checking
for an existing task; do not repair them as part of this testing-only change.

## Results

Exploratory iPad runs are in progress; final coverage is not established yet.
They have exercised navigation, local demo sends and draft rotation, but the
complete scrolling and software-keyboard journeys still need proof. The Duo
journeys have not started. A result must distinguish observed behavior from
missing proof and must not treat a successful build as a successful application
journey.
