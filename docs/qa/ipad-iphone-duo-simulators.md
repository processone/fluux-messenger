# iPad and iPhone Duo simulator checks

## Scope and result

FLM-50 requests testing Fluux on an iPad simulator and on **iPhone Duo**.
The requested Duo target is the iPhone Duo simulator, not two devices running
together and not iPad Split View or Stage Manager. Every iPad flow covers both
portrait and landscape, including rotation during an open conversation, typing
and list scrolling.

**Result: partial simulator coverage, with no confirmed Fluux defect in the
exercised views.** The native iPad journeys ran in both orientations. Rotation
keeps the bottom anchor by design; an upper message leaving the shorter landscape
view is expected, not a defect. The Duo primary-screen journeys also ran.

**Verdict: inconclusive**, because the Duo second screen, a real Duo landscape
and the fold transition remain untested. The bounded secondary-screen attempt
could not start its test process. The iPad rotation is not a reason for no-go.
FLM-177 later ran those Duo cases; see
[Duo special cases](#duo-special-cases-flm-177).

These checks use the real native shell with the project's isolated demo
(`net.processone.fluux.demo`) and its existing conversation fixtures. Demo sends
are local simulation, not XMPP delivery. No real account, personal keychain,
signing identity or remote notification service was used. No product code was
changed.

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
| Rotate with scrolled message history | Bottom anchoring retained on return; upper messages re-enter the taller view | Bottom anchor kept as intended; upper message leaves the shorter view |
| Rotate with sidebar open | Landscape list was scrolled; all fixture rows fit after rotation and selection remains | Rotation started from an unscrolled portrait list; list remains usable and selection remains |

Seven XCTest methods finished without assertion failures. The earlier top-row
visibility diagnostic is not a valid failure criterion for the intended
bottom-anchor resize behavior. The iPad rotation is not a confirmed defect;
missing Duo coverage still prevents complete qualification.
Initial exploratory runs also failed on stale live element indexes and hidden
keyboard controls. The final driver reads an immutable message snapshot and
checks actual keyboard geometry; earlier logs remain separate from final proof.

### Expected rotation behavior: bottom anchoring

The [scroll-positioning contract](../2026-07-23-scroll-positioning-contract.md)
preserves a bottom-relative reading anchor rather than pinning the top row.

1. Open Ava's demo conversation on the iPad in portrait.
2. Scroll toward its beginning until “I've been reviewing the Q1 user feedback —
   a few themes keep coming up” is visible near the top of the history.
3. Rotate to landscape without scrolling again.

Expected: keep the bottom anchor in place as the viewport becomes shorter;
the previously visible top message need not stay visible.
Observed: the bottom message stays in place. The upper message moves above the
viewport and “What are the top asks?” becomes the first visible message; the
upper message returns on the reverse rotation. This is the intended resize
behavior, not message loss or a Fluux defect.

The **FLM-50 task record** contains the before/after orientation captures and
the native log. Its top-row visibility diagnostic records which upper message
left the view; it does not establish a failure of the expected bottom anchoring.
The steps above remain the reproduction procedure.

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
screen 1 power off and screen 3 power on. The boot message
`Data Migration Failed` was seen in the job output, but that boot output was
not kept as an evidence file; this is an observed, unretained message, not a
claim supported by the retained logs. The retained test-launcher log reports
`Host is down`, with the shell described as probably crashed. No Fluux UI
journey ran on the secondary screen, and no post-switch application screenshot
was obtained. No automatic retry was made, and cleanup stopped the simulator.
FLM-177 later found the cause: powering off screen 1 makes every SpringBoard
start abort. See [Why `Host is down`](#why-host-is-down).

The **FLM-50 task record** holds the primary-screen journey log, display
inventory, display-power confirmations, failed test-launcher log and the
intentionally black secondary-screen capture. The second screen, a real Duo
landscape and the fold transition were untested in FLM-50; none is a passing
result there. FLM-177 ran them below.

## Duo special cases (FLM-177)

FLM-177 follows FLM-50 with the remaining Duo cases: an external screen, the
built-in second screen, the app split across both screens in portrait and in
landscape, and the move between screens when the device folds.

**Result: Fluux worked in every case, with no confirmed Fluux defect.** The
external screen's mirrored picture could not be captured in the simulator; it
is recorded as an accepted gap, not a pass. When
the Duo is half open, the hinge runs through Fluux's chat pane, because the web
view gets no hinge information by default. See
[Hinge and viewport segments](#hinge-and-viewport-segments).

### FLM-177 environment and method

| Item | Recorded value |
| --- | --- |
| Duo | Disposable `Fluux-FLM177-Duo`, iOS 27.1 build 24A94232, WebKit 8625.1.29.10.29 |
| Toolchain | Xcode 27.1, build 27A9275 |
| App | Native demo `net.processone.fluux.demo` 0.18.1, built with `npm run tauri:ios:demo` after `npm ci` |
| Source | App sources of `d2418a881904`, the main-line version the FLM-177 branch is based on; the branch changes only this document |
| First pass | The same cases on app sources of `d3bbf25ff4bc` gave the same results; the tables below come from the run on `d2418a881904` |

The Duo has two built-in screens, and only one shows content at a time:

- Screen 1, `LCD`: the cover, 466×678 points, used when the Duo is closed.
- Screen 3, `LCD-1`: the inner screen, 669×951 points, used when it is open.
  It is one panel across both halves of the fold.

Screen 2, `TVOut`, is a 720×480 external screen. Screens 4 and 5 (CarPlay and
a resizable scene) were not part of this task.

An XCTest driver attached to the running demo for each step. It recorded the
web view frame, the composer and the layout, and saved a screenshot of every
screen. The hardware keyboard was disconnected on this simulator only, as in
FLM-50. The process ID of Fluux was recorded before and after each step. It
stayed the same through every case below, so no step restarted the app.

The driver waits for the software keyboard and for the typed draft to appear in
the composer's value. Without those waits, two steps failed on the driver side
while Fluux was fine: the keyboard check was interrupted while reading the app
frame, and the composer's value was read before it updated. The next steps
found the keyboard and the draft in place.

Folding, unfolding and turning the inner screen need SpringBoard's display tool
service, because the simulator has no fold control without Simulator.app.
Setting `XCUIDevice.shared.orientation` left the inner screen's interface
unchanged. A small simulator tool therefore calls
`-[SBSDisplayToolService swapDisplayWithSettings:completionHandler:]` from
SpringBoardServices. The service requires the
`com.apple.springboard.sbdisplay.service` entitlement. Signing the tool with
that entitlement fails with “Security policy issue”; embedding the entitlement
plist in the tool's `__TEXT,__entitlements` section works, with no signing
identity. The swap settings take a hinge position from 0 (closed) to 1 (fully
open) and an orientation. Screen 1 stayed powered on throughout.

### FLM-177 results

| Case | Result |
| --- | --- |
| Built-in second screen | Fluux runs on the inner screen in both orientations. Keyboard, one local send, settings and switching between Emma and James worked in landscape and in portrait. |
| Split across both halves, landscape | 951×669 web view with two panes: icon rail 0–56 points, conversation list 56–288, chat 288–867. A status strip takes the right 84 points. A typed draft stayed in the composer. |
| Split across both halves, portrait | 669×951 web view with one pane and the “Retour aux conversations” back button. The draft survived the turn from landscape. |
| Fold, inner to cover | Same process, same open conversation, draft kept. The cover showed one pane at 678×466. It was in landscape because the device orientation used to show the inner screen in portrait is landscape on the cover. The cover stayed black for about 17 seconds after the fold request before Fluux appeared on it. |
| Unfold, cover to inner | Same process; back to 669×951 with one pane and the draft kept. |
| External screen | Fluux kept running and the full journey passed with screen 2 connected, after disconnecting it, and after reconnecting it. The mirrored picture is unproven, an accepted gap (see below). |

The software keyboard covers the lower part of the inner screen in landscape,
including the bottom of the conversation list. That is expected for a phone
keyboard and was not classified as a defect.

When the first send with screen 2 connected ran, the composer still held the
earlier drafts. The tap that focused it put the caret before that text. The
message was sent with the drafts after it, so the driver's exact-text check
failed. The same journey then passed with an empty composer. This tap placement
was seen only through XCTest and is not classified here.

The external screen has two limits:

- **It shows a mirror, not a Fluux window.** Fluux declares only the standard
  application scene role (`UIWindowSceneSessionRoleApplication`). For such an
  app iOS mirrors the active built-in screen: the system log shows `backboardd`
  “cloning `LCD-1` to `TVOut`” when screen 2 connects. Fluux gets no window of
  its own on that screen.
- **The simulator does not draw that mirror.** Every capture of screen 2 was
  black: `simctl io screenshot`, `simctl io recordVideo` (a single near-black
  frame) and `XCUIScreen.screenshot()`. So the mirrored content itself is not
  shown here.

**Gap exception.** On 30 October 2026 the captain accepted the external
screen's picture as unproven on the FLM-177 task, because the simulator cannot
draw screen 2. The external-screen case is therefore not a full pass: Fluux's
behavior with screen 2 connected, disconnected and reconnected was shown, but
what the mirror displays still needs a physical Duo connected to a display.

Screen 2 reported power on at boot but returned no picture: its screenshot
timed out. Turning screen 2 (never screen 1) off and on again made SpringBoard
connect it as a 720×480 display. After that, XCTest listed three screens
instead of two.

### Hinge and viewport segments

When the Duo is half open, the inner screen stays on and the hinge sits exactly
across its middle. For web pages, the standard way to follow a hinge is the
CSS Viewport Segments API:

- `env(viewport-segment-*)` values;
- the `horizontal-viewport-segments` and `vertical-viewport-segments` media
  queries;
- `window.viewport.segments`.

The Device Posture API adds `navigator.devicePosture` and the `device-posture`
media query.

A probe app with a default `WKWebView`, as Fluux uses, read these in eight
setups: fully open (180°) and half open (90°), in portrait and in landscape,
with WebKit's two features at their defaults and turned on. The display tool
service set the hinge and the orientation. The probe started fresh for each
setup and saved its own report. The table gives the last reading of each
setup.

| Posture | Default web view | With WebKit's two features turned on |
| --- | --- | --- |
| Fully open (180°), portrait | Nothing: no segment values, no segment or posture query matches, no `window.viewport`, no `navigator.devicePosture` | One segment covering the 669×951 page; `horizontal-viewport-segments: 1` and `vertical-viewport-segments: 1`; `device-posture: continuous`; no `env(viewport-segment-*)` values |
| Fully open (180°), landscape | Nothing, as above | One segment covering the 951×669 page; the same two queries match; `device-posture: continuous`; no `env(viewport-segment-*)` values |
| Half open (90°), portrait | Nothing, as above | Two 669×475.5 segments, one above the other, split at 475.5 points; `vertical-viewport-segments: 2`; `device-posture: folded` |
| Half open (90°), landscape | Nothing, as above | Two segments side by side, split at 475.5 points from the left; `horizontal-viewport-segments: 2`; `device-posture: folded` |

With the features off, `CSS.supports()` rejects
`env(viewport-segment-width 0 0)`; with them on, it accepts it. The
`env(viewport-segment-*)` values exist only when the page has two or more
segments, so they are absent when the Duo is fully open. In the half-open
landscape reading the page measured 867×635 points. That leaves out the
84-point status strip on the right and 34 points at the bottom, so the second
segment was 391.5 points wide. In the first pass, on the full 951-point page, it
was 475.5 points wide. The hinge was at 475.5 points from the left both times.

WebKit in this runtime contains both features, “Viewport Segments API” and
“Device Posture API”, but a `WKWebView` has them off by default. WebKit labels
both as testable, a stage before preview and stable. The probe turned them on
through WebKit's private `_setEnabled:forFeature:` preference. The hinge has no
width in WebKit's report: the two segments touch. These are simulator results;
a physical Duo may report differently.

Fluux's iOS native code does not change these WebKit settings, so its web view
gets nothing. With the Duo half open, Fluux keeps its flat layout:

- In landscape the hinge at 475.5 points cuts through the chat pane (288–867),
  including message bubbles and the composer. The system keyboard does follow
  the hinge: half open, it splits its keys to either side of it, while flat it
  is one piece.
- In portrait, with the keyboard open, the hinge runs just below the composer,
  across the strip above the keyboard.

On the native side, UIKit 27.1 adds a public `UIHingeInteraction`. It reports
the hinge state (closed, partially open, fully open) and its angle. The probe
saw `fullyOpen` at 180° and `partiallyOpen` at 90° in every setup. UIKit
offers no public position for the hinge, and the Duo's simulator profile
declares none. A native layer would have to assume the middle of the inner
screen, which is where WebKit's segments put it.

How Fluux should adapt was a product choice between standard CSS segments
with WebKit's features turned on and hinge values passed from native code as
CSS variables. On 30 October 2026 the captain chose the native values: Fluux's
iOS code reads `UIHingeInteraction` and sets the posture and the hinge line on
the page as CSS variables, with the hinge assumed at the middle of the inner
screen. Half open, the layout is to split at the hinge: the conversation list
and the chat on either side in landscape, the messages above and the composer
with the keyboard below in portrait. That change is separate work and is not
built here.

### Why `Host is down`

Screen 1 (`LCD`, the cover screen) is the simulator's main display. FLM-50
powered it off to reach screen 3. SpringBoard can keep running while screen 1
is off, but any SpringBoard start then aborts while the system shell
initializes. The assertion in
`-[SBMainDisplayConfigurationTransformer transformDisplayConfiguration:]` reads
“We expect a valid bounds for configuration”, for a main display whose mode is
0×0. launchd restarts SpringBoard about every 30 seconds, and each start
aborts again. During that loop every app launch or termination fails with “The
system shell probably crashed”. FLM-50's test launcher reported the termination
part as POSIX error 64, `Host is down`.

FLM-177 reproduced this on a fresh Duo simulator before Fluux was installed:

1. Boot with the default screen power: screens 1 and 3 on.
2. Power off screen 1 with
   `xcrun simctl io <udid> screenConfig --display=1 power off`.
3. Restart SpringBoard. The shell that was already running survives step 2;
   a new one does not.

Each SpringBoard start then aborted with the same stack as FLM-50's crash
report, and `xcrun simctl launch <udid> com.apple.Preferences` failed with the
same shell-crashed error. Powering screen 1 back on ended the crash loop.
Launches still hung and both screens stayed black, so the simulator had to be
shut down. What restarted SpringBoard during FLM-50 is not recorded; it started
one second after the test command.

**Keep screen 1 powered on.** If it was powered off, power it on and shut down
the simulator before the next run.

## Evidence record and local gate

Refer to the **FLM-50 task record** for binary provenance, runtime/WebKit
inventory, exact XCTest driver sources,
keyboard-disconnection helper, orientation captures, and failed as well as
successful run logs. Local evidence-folder filenames are temporary, not durable
references from this document.

The record also contains a silent, real-time 13.3-second extract showing
portrait → landscape → portrait while composing, with the draft retained and
locally sent. Its native frame buffer rotates content; black side bars preserve
the whole portrait image rather than cropping it. The poster and extracted
contact sheet were inspected. No evidence is stored in the working copy.

The **FLM-177 task record** holds its own evidence for both passes: per-step
driver logs and screenshots of every screen, the fold recordings, the
SpringBoard and `backboardd` display logs and the black captures of screen 2,
one probe report and screenshot for each of the eight hinge setups, the build
record of the demo, and the sources of the driver, the display tool and the
probe. None of it is stored in the working copy.

The report changes documentation only. `npm run test:local -- --base origin/main`
selected no tests for the explicitly recognized documentation path and completed
successfully; `git diff --check` also passed. Native runtime evidence above is
separate from that documentation gate. No full product qualification or release
gate is claimed.
