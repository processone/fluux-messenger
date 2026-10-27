# iPad and iPhone Duo simulator checks

## Scope and result

FLM-50 requests testing Fluux on an iPad simulator and on **iPhone Duo**.
The requested Duo target is the iPhone Duo simulator, not two devices running
together and not iPad Split View or Stage Manager. Every iPad flow covers both
portrait and landscape, including rotation during an open conversation, typing
and list scrolling.

**Result: not fully qualified.** The native iPad journeys ran in both
orientations, but a portrait-to-landscape rotation moved the message being read
above the viewport (FLM-172). The Duo primary-screen journeys ran; its second
screen and an effective landscape transition remain unverified because the
bounded secondary-screen attempt could not start its test process.

These checks use the real native shell with the project's isolated demo
(`net.processone.fluux.demo`) and its existing conversation fixtures. Demo sends
are local simulation, not XMPP delivery. No real account, personal keychain,
signing identity or remote notification service was used. No product code was
changed and FLM-172 remains a separate planned correction.

This is an interface check, not release qualification. Physical-device
keyboard/touch behavior, fold hardware, networking, encryption, push delivery
and cross-device synchronization remain outside its scope. See
[platform qualification](../PLATFORM_REGRESSIONS.md) for those boundaries.

## Environment and provenance

Final application journeys ran on 27 October 2026; earlier exploratory runs
on 26 October exposed test-harness and keyboard-configuration limitations.

| Item | Recorded value |
| --- | --- |
| Host | macOS 27.0, build 26A428; session unlocked before simulator runs |
| Toolchain | Xcode 27.1, build 27A9275; unsigned arm64 simulator archive |
| iPad | iPad Pro 11-inch (M5), iOS 27.0 build 24A434; 834×1210 portrait / 1210×834 landscape points |
| Duo | iPhone Duo, iOS 27.1 build 24A94232 in test logs; primary app frame 466×678 points |
| WebView | Runtime WebKit bundle 8625.1.29.10.29 for those two runtime builds |
| App data | Fresh task-owned simulators named Fluux-FLM50-iPad and Fluux-FLM50-Duo; demo container only |

The archive was built from commit
`7297c30fb557b9eaa50edc0579c3a102896b6c64`. The final simulator journeys used a
clean checkout at `472830aa71a49f60048405daa3ca82c9919ad2d4`. A source comparison
confirmed no application, SDK, script, dependency or Cargo-configuration change
between that checkout and the archive's source. Application and SDK sources also
matched main at `be0bdbb91f61cc7259f2545814c70b58280f3af3` when checked. Later
report-only commits are not new binary builds.

**Select the iOS 27.1 runtime for iPhone Duo. iOS 27.0 is not sufficient.**
Check `xcrun simctl list devices available` and use a UUID rather than an
ambiguous device name. The existing iPhone Duo target was confirmed available;
the tests used a separately named disposable target of the same device type and
runtime to avoid changing that existing device's data. At the final inventory,
two iOS 27.1 builds shared the runtime identifier; the logs above identify the
build actually reported by the test runner, not qualification of both builds.

## Setup and execution

Use the [native demo launcher](../IOS_DEVELOPMENT.md#run-the-isolated-demo),
including its one-time initialization. Build from a clean committed checkout and
keep build provenance with the evidence. Do not substitute a desktop browser at
the same viewport for native simulator evidence.

Keep the Mac unlocked. Before each heavy job, inspect full process paths and
booted devices. Let existing jobs finish and run only one heavy job at a time.
Stop the iPad before starting Duo. The final cleanup stopped both task-owned
simulators; no test runner or recording process was left running.

The graphical Simulator application was not found in the active developer
folder, other Xcode installations in `/Applications`, or Spotlight by bundle
identifier `com.apple.iphonesimulator`. Testing therefore used `simctl` and
XCTest without that application. No manual simulator interaction or account was
needed.

The first keyboard checks were insufficient: accessibility reported a keyboard
that had zero height and was not visible. The same condition occurred in a
minimal native text-field control, so it was not classified as a Fluux bug.
Disconnecting the hardware keyboard through the task device's CoreSimulator
`setHardwareKeyboardEnabled:keyboardType:error:` API resolved it. This changed
neither global Mac preferences nor another simulator. Final assertions required
a keyboard occupying visible screen space, and screenshots were inspected.

The temporary XCTest drivers launched the installed native demo by bundle ID.
The iPad driver exercised navigation, composition/lifecycle and in-use rotation;
the Duo driver exercised its actual primary-screen UI and measured its frame.
Driver source, setup helper, logs, captures and the short recording are retained
with FLM-50 outside the project, not committed as product code or test artifacts.

## iPad results by orientation

| Flow | Portrait | Landscape |
| --- | --- | --- |
| Open Emma, switch to James | Observed usable | Observed usable |
| Open settings, return to messages | Observed usable | Observed usable |
| Scroll conversation sidebar | Fixture fits; attempted scroll does not move rows | Sidebar moves; Olivia's row moves upward |
| Scroll message history | Different earlier message becomes visible | Different earlier message becomes visible |
| Software keyboard and composer | Visible; keyboard frame 834×282 points | Visible; keyboard frame 1210×370 points |
| Type and send a unique demo message | One local message observed | One local message observed |
| Dismiss keyboard, background and foreground | Keyboard hidden; conversation and local message remain usable | Keyboard hidden; conversation and local message remain usable |
| Rotate with a conversation open | Selection remains Ava after return from landscape | Selection remains Ava after rotation from portrait |
| Rotate while typing | Draft survives return; further typing and local send work | Draft survives arrival; further typing works |
| Rotate with scrolled message history | Sampled message remains visible on landscape-to-portrait | **Reading-position shift on portrait-to-landscape; FLM-172** |
| Rotate with scrolled sidebar | All fixture rows fit after rotation; selected conversation retained | List remains usable after rotation; selected conversation retained |

Seven XCTest methods finished without assertion failures. That status is **not**
a complete behavioral pass: the reading-anchor check logged visibility rather
than asserting it, and image inspection exposed the failure described below.
Initial exploratory runs also failed on stale live element indexes and hidden
keyboard controls. The final driver reads an immutable message snapshot and
checks actual keyboard geometry; earlier logs remain separate from final proof.

### Finding: portrait-to-landscape reading-position shift

Tracked separately as **FLM-172**, not repaired in this change.

1. Open Ava's demo conversation on the iPad in portrait.
2. Scroll toward its beginning until “I've been reviewing the Q1 user feedback —
   a few themes keep coming up” is visible near the top of the history.
3. Rotate to landscape without scrolling again.

Expected: the message being read remains visible across the rotation.
Observed: that message moves above the viewport; “What are the top asks?” is the
first visible message after rotation. The sampled reverse transition retained
its anchor. This is a position shift, not evidence of message loss.

Evidence: `ipad-message-list-portrait-second-scroll.png`,
`ipad-message-list-landscape-after-rotation.png` (also retained upright), and
`ipad-validated.log`, including `ROTATION_ANCHOR portrait-to-landscape ...
visible=false`. Log the affected orientation as **landscape after portrait**;
do not report both directions as failing.

## Duo results and limits

The three primary-screen XCTest methods finished without assertion failures.
On the real 466×678 app frame they opened Emma and James, returned to the list,
opened settings, showed the software keyboard, sent one local demo message and
returned from the background to a usable conversation.

The method named landscape requested landscape orientation, but its measured
frame stayed **466×678**. It is therefore **not** proof of a landscape layout.
The portrait and requested-landscape captures document the same actual geometry.

`simctl io ... enumerate` exposed two integrated screens:

- LCD / screen 1: 1398×2034 pixels.
- LCD-1 / screen 3: 2007×2853 pixels.

The bounded secondary-screen attempt captured a black screen 3, then confirmed
screen 1 power off and screen 3 power on. Its boot had reported
`Data Migration Failed`; the test runner then failed to launch because the
simulator system was unavailable (`Host is down`, with the shell reported as
probably crashed). No Fluux UI journey ran on the secondary screen, and no
post-switch application screenshot was obtained. These observations do not
establish the cause or a Fluux crash. No automatic retry was made, and cleanup
stopped the simulator.

Evidence: `duo-default.log`, `duo-displays.txt`,
`duo-inner-display-control.log`, `duo-second-screen.log` and the intentionally
black `duo-secondary-before-switch.png`. The missing second-screen, effective
landscape and fold-transition proof remains explicit; it is not a passing result.

## Retained proof and local gate

The task evidence includes the native build/init logs, binary provenance,
runtime/WebKit inventory, exact XCTest driver sources, keyboard-disconnection
helper, orientation captures, and failed as well as successful run logs.
`ipad-draft-rotation.mp4` is a silent, real-time 13.3-second extract showing
portrait → landscape → portrait while composing, with the draft retained and
locally sent. Its native frame buffer rotates content; black side bars preserve
the whole portrait image rather than cropping it. The poster and extracted
contact sheet were inspected. No evidence is stored in the working copy.

The report changes documentation only. `npm run test:local -- --base origin/main`
selected no tests for the explicitly recognized documentation path and completed
successfully; `git diff --check` also passed. Native runtime evidence above is
separate from that documentation gate. No full product qualification or release
gate is claimed.
