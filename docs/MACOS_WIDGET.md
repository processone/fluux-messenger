# macOS unread-conversations widget

On macOS 14 and later, the native WidgetKit extension offers small, medium and
large widgets. It reads the same `UnreadWidget.json` schema as the iOS widget; it
never connects to XMPP. The host keeps its existing deployment target: its Objective-C
loader does not link Swift or WidgetKit and loads the Swift writer only on macOS 14+.
Intel release dependency inspection proves that link boundary, not an actual launch on an older Mac.

The list follows the app icon badge's conversation rule: direct chats with unread
messages, rooms with a mention, and rooms set to notify on every message. Pending
invitations and contact requests contribute to the total but have no rows. Rows
sort by newest activity and contain names, unread counts, mention markers and
times, never message text. Small shows the total and two names; medium shows
three rows; large shows six. English and French are included.

A medium or large row links to its conversation through the app's registered
scheme. The app validates the link's account and conversation before navigating.
The small widget and the background of other sizes open the conversation list.

## Ownership and storage

- The SDK selector owns unread semantics; `utils/unreadWidget.ts` publishes the
  list from the app's stores. Desktop publication continues while the window is
  closed. It renews the timestamp once every fifteen minutes, including when nothing changed.
- `platform/apple/conversationMirror.ts` shares cached avatar bytes and names.
  The session hook and sign-out lifecycle import this Apple owner directly on both
  platforms. macOS sends these operations to the widgets plugin, not the push plugin.
  Sign-out revokes promptly and queues a final wipe after pending writes; the next
  account's publication waits behind that wipe.
- `plugins/widgets/src/desktop.rs` exposes metadata-only commands. The Swift
  adapter in `plugins/widgets/macos/WidgetsBridge.swift` resolves the signed host's
  `FluuxShareGroup` and writes through the shared list and avatar model. IPC never
  supplies a filesystem path. Avatar writes are account-bound, size-limited,
  hash-named JPEG thumbnails, with metadata stripped by Image I/O.
- The widget's Swift model and views remain shared with iOS. The timeline owns the
  selected container so avatar reads follow the same account as the list.
  Another account's list is hidden. Sign-out removes the list, names and avatars.

WidgetKit controls redraw scheduling, particularly with the window closed. A
reload request is not a guarantee of an immediate redraw. Fifteen minutes after its
last publication, the timeline marks a retained list as the last saved list and
asks the reader to open Fluux. This is an age indicator, not a claim that the
process has quit; force-quit, delayed timers or system throttling may also leave
an old snapshot. Midnight entries keep day labels current.

## Build and signing

`tauri-macos-share.mjs --prepare` derives settings from Tauri's merged identity,
team and version. `tauri-macos-widgets.mjs` uses those same settings to compile
`FluuxWidgets.appex` for the requested architecture (or both for universal), with
macOS 14 as the extension minimum. `tauri.macos.conf.json` runs the Share Extension
builder and then the widget builder before Tauri bundles and signs the host.
Both extensions are embedded in `Contents/PlugIns`; Tauri does not re-sign them.
The optional `libFluuxWidgets.dylib` is embedded in `Contents/Frameworks` and signed
before the extension and host. A library or widget build/sign failure stops bundling.

The widget uses the same `<TEAM>.<host identifier>.share` App Group as FluuxShare;
the optional writer resolves that container using the host's entitlements.
The widget's entitlements contain only sandbox and App Groups. It needs no new App ID or
provisioning profile for Developer ID distribution. Development identity builds
use their own group and conversation-link scheme. No provisioning record is
created by the widget builder.

The widgets plugin's `build.rs` compiles only an Objective-C loader into the host.
The widget builder compiles the shared Swift writer as `libFluuxWidgets.dylib`
(macOS 14 minimum), embedded in `Contents/Frameworks` and signed before the host.
The loader checks the OS version before opening that exact bundled path; older
Macs acquire no Swift runtime dependency. The webview also gates publication and
avatar mirroring on the native OS version, so pre-widget Macs do no widget work.
Changed unread-list content and the explicit fifteen-minute timestamp heartbeat
request a widget refresh. Ordinary duplicate lists ignore the timestamp and do not
rewrite the file. A names write also refreshes when it changes the active account,
so sign-in and account replacement do not wait for the widget's retry timeline.
Other names changes and avatar writes do not request a refresh. The mirror still contains all
contacts, rooms and conversation suggestions on supported Macs, as on iOS.
If the optional library is absent in an unbundled development process, the native
plugin logs once and reports unsupported for that process. Both webview producers
then stop for the session instead of rebuilding and retrying the full mirror.
No keychain operation is needed for unsigned compilation.

## Unsigned checks

From the project root, on macOS with Xcode:

```sh
node --test scripts/macos-widgets.test.mjs
```

This compiles a universal unsigned extension, checks bundle metadata, runs the
actual Swift shared-file adapter against a disposable directory and a real image,
and renders small/medium/large unread, empty, signed-out and stale views in both
languages. Set `FLUUX_WIDGET_RESULTS` to an output directory outside the project
to retain those pictures. The fixture does not register an app, resolve an App
Group, sign anything or access a keychain. It also compiles the bridge against
the application's existing macOS deployment minimum, without linking Swift into that host loader.

For a standalone unsigned build, prepare metadata first, then explicitly select
unsigned output:

```sh
node apps/fluux/scripts/tauri-macos-share.mjs --prepare
TAURI_ENV_ARCH=universal node apps/fluux/scripts/tauri-macos-widgets.mjs --unsigned --output /tmp/fluux-widget-check
```

The normal bundle build still signs the extension. Do not run it when signing
access is not authorized.

## Required signed qualification

Unsigned compilation and rendered views do not prove WidgetKit registration or
App Group entitlements. Before claiming desktop qualification, use an authorized,
isolated test app/user and signing runner to check:

1. The widget appears in the desktop and Notification Center gallery after the
   host opens, including installation outside Applications.
2. A signed app publishes into the exact container its signed widget reads;
   names and avatars match, account replacement hides old content and sign-out
   clears the widget.
3. Row clicks open the expected conversation, while other clicks open the list;
   stale or wrong-account links fall back safely.
4. Unread changes continue with the window closed; after quit the saved list
   becomes stale. The system may defer reloads.
5. Replacing the app with the next signed build retains a working widget rather
   than a grey placeholder.
6. Both extensions and `Contents/Frameworks/libFluuxWidgets.dylib` pass strict
   signature verification before host verification, and the packaged app passes
   notarization in the release dry run.

A `swiftc`-built extension has not yet been qualified in the system gallery. If
that registration fails because the bundle needs an Xcode-built target, use
`xcodebuild` for this extension rather than treating compilation as registration.
