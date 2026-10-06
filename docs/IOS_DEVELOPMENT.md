# iOS development: build and install

[Developer guide](DEVELOPER.md) · [Android development](ANDROID_DEVELOPMENT.md)

Run commands from the repository root unless stated otherwise.

iOS is an opt-in development target and is not part of the release workflow.
Its identity is `net.processone.fluux` (Fluux Messenger iOS Dev), the same as a
release build: the signing, not the identifier, separates development from
production. The desktop executable keeps its own entry point and plugins; the mobile library
loads the OS, opener, notification, push and share-inbox plugins, the shared XMPP
proxy commands, and the keychain and native OpenPGP commands. The iOS config is
selected automatically by `tauri ios`, not by desktop or web builds.

## Install the toolchain and initialize

Use a Mac with full Xcode, an installed iOS Simulator runtime, Node.js 24,
Rust and CocoaPods (`brew install cocoapods`). Xcode 27 also needs Rust's
`llvm-tools` component so `swift-rs` can export its Swift runtime symbols:

Install Xcode, launch it once and complete its license/component setup. Install
an iOS Simulator runtime from Xcode Settings. Check that the active developer
directory points to full Xcode:

```bash
xcode-select -p
xcodebuild -version
```

If it points to Command Line Tools or another Xcode installation, select the
intended Xcode (adjust the path if needed):

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

Install the Rust device target plus the simulator target for your Mac:
`aarch64-apple-ios-sim` on Apple silicon, or `x86_64-apple-ios` on Intel.
For Apple silicon:

```bash
brew install cocoapods
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
rustup component add llvm-tools
npm ci
npm run tauri:ios:init
npm run tauri:ios:build
```

Initialization installs the mobile toolchain dependencies and generates the
ignored `apps/fluux/src-tauri/gen/apple/` project. Regenerate it in each checkout
and after changing native plugins or the iOS configuration. The native XMPP
proxy requires the `SystemConfiguration.framework` declared in the iOS config.
Do not copy a generated project between worktrees or edit generated files to
configure the app.

## Generated project and icons

The npm iOS commands generate the Xcode icon catalog after initialization and
before each build or launch. They use the selected `VITE_FLUUX_ICON_STYLE`
(default `hollow`) and its full-bleed SVG, letting iOS apply the corner mask.
This runs Tauri's icon generator without changing desktop or Android icons.
Direct Xcode builds also prepare the catalog through the app's `tauri` npm
entrypoint, which the generated Xcode pre-build phase invokes. Icon generation
must succeed before the Rust build proceeds.
When invoking `tauri ios` directly, first run
`npm run tauri:ios:icons -w @xmpp/fluux` after initialization. Verify icon
preparation with `npm run test:ios-icons`.

## Build and install in Simulator

List the available simulators, then use a unique name or UDID from the output:

```bash
xcrun simctl list devices available
npm run tauri:ios:sim -- "SIMULATOR_NAME_OR_UDID"
```

The script builds, boots the selected simulator if needed, installs the `.app`
and launches it. For build only, use `npm run tauri:ios:build`. The archive is
under `apps/fluux/src-tauri/gen/apple/build/fluux_iOS.xcarchive/`, with the `.app`
in `Products/Applications/`. This build embeds the frontend and needs no Vite
server; network access is still needed to connect to your XMPP account.

The build command creates an unsigned debug simulator archive for the Mac's
architecture. It neither creates a release nor uploads to App Store Connect. To
build, install and launch the connected app in a simulator, run
`npm run tauri:ios:sim -- "Simulator name"`; this also chooses the correct target
on Intel Macs. An already booted simulator can be used without a name when it
is the only one booted. For live edits, use `npm run tauri:ios:dev -- --open`,
select a simulator in Xcode and press Run. On iOS, Tauri replaces the loopback
host with the Mac's network address, so Vite listens on all interfaces. If the
device cannot load the page, make
sure it can reach the Mac on the same network and that port 5173 is allowed.

## Run the isolated demo

For layout checks with fake conversations and no XMPP account, use the native
demo after the same one-time `tauri:ios:init` setup:

```bash
npm run tauri:ios:demo
# Or select an existing simulator by name:
npm run tauri:ios:demo -- "Fluux iOS QA"
```

This builds and installs **Fluux iOS Demo** (`net.processone.fluux.demo`)
alongside the connected development app. Its separate data container keeps the
demo's storage reset away from real accounts. The app embeds
`demo.html?tutorial=false`, so it opens without a running Vite server or a
reachable Mac. For live layout edits, use `npm run tauri:ios:demo:dev`,
select a simulator in Xcode and press Run. This starts Vite on port 5194 and
listens on all interfaces. Run one iOS Tauri command at a time per checkout:
the variants share a generated Xcode project and build outputs. Tauri updates
the bundle identity from the selected configuration on each launch/build.
The demo configuration is only selected by this command and stays outside
production builds and releases.

## Xcode compatibility

The Cargo lockfile pins a temporary `swift-rs` fix for Xcode 27. The repository's
`.cargo/config.toml` selects Tauri as the sole archive exporting the shared
Swift runtime. Keep both files together when copying this setup to another
checkout; remove the pin after an upstream release includes the fix. If a
machine built iOS with the older dependency, rebuild the iOS target rather
than reusing its Cargo or Xcode cache.

## Install and run on an iPhone or iPad

1. Connect and unlock the device, accept **Trust This Computer**, and confirm
   that Xcode recognizes it as a run destination. Install Xcode platform support
   compatible with the device's iOS version if requested.
2. Add your Apple Account in Xcode Settings. Select a development team and enable
   automatic signing for the app target. Xcode must have a development
   provisioning profile covering this device and app identifier.
3. Enable **Developer Mode** in the device's **Settings → Privacy & Security**
   when requested, restart and confirm. Follow
   [Apple's device setup](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)
   and [Developer Mode instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).
4. Set the team ID locally and launch the development workflow:

```bash
export APPLE_DEVELOPMENT_TEAM="YOUR_TEAM_ID"
npm run tauri:ios:dev -- --open
```

Select the physical device in Xcode and press **Run**. Keep the Tauri command
running for hot reload, and let the device reach the Mac's Vite server on port
5173. This uses the identity `net.processone.fluux`.
Signing credentials and team IDs belong to local configuration, not committed
files. Set the team environment before initialization too when Tauri requests it.

## Install a device build without Vite

After the device's signing/provisioning setup works, build a signed debug device
archive with embedded frontend assets. Unlike `tauri:ios:build`, this explicitly
selects the physical-device target and does not use `--no-sign`:

```bash
export APPLE_DEVELOPMENT_TEAM="YOUR_TEAM_ID"
npm run tauri:ios:install
```

The install command builds the SDK, prepares the iOS icons, creates a signed
device archive, checks the app identity and signature, then installs it. It
lists known iPhones and iPads and asks for a device number before building.
Empty or invalid answers prompt again, up to three attempts. Enter `0` to cancel.
To skip the menu, pass an identifier from `xcrun devicectl list devices` as
`npm run tauri:ios:install -- "DEVICE_ID"`. The command does not launch the app.
The menu requires interactive terminal input. When running from automation or
with redirected stdin, pass the device identifier explicitly.
To perform the steps separately, use:

```bash
export APPLE_DEVELOPMENT_TEAM="YOUR_TEAM_ID"
npm run build:sdk
npm run tauri:ios:icons -w @xmpp/fluux
npm run tauri -w @xmpp/fluux -- ios build --debug --target aarch64 --archive-only
xcrun devicectl list devices
```

Locate the `.app` in the archive's `Products/Applications/` directory. Install
it using the physical device identifier and the actual `.app` path:

```bash
xcrun devicectl device install app --device "DEVICE_ID" "PATH_TO_SIGNED_APP"
```

Launch **Fluux Messenger iOS Dev** on the device. The embedded frontend does not
need the development server. An unsigned simulator archive cannot be installed
on an iPhone, even on an Apple silicon Mac. Device and simulator archives share
an output location: rebuild for the intended target before selecting the `.app`.
These commands do not upload to App Store Connect or TestFlight.

## Privacy manifests

App Store Connect rejects a build whose bundles call a
[required reason API](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)
without declaring it. The app and the share extension each carry a
`PrivacyInfo.xcprivacy` from `src-tauri/mobile/ios/privacy/`, which the
`project.yml` template copies into their bundles. The notification extension
calls none of these APIs and has no manifest.

The app declares file timestamps (`C617.1`), system boot time (`35F9.1`) and
user defaults (`CA92.1`); the share extension, file timestamps (`C617.1`), to
clear stale imports from the App Group. Neither declares tracking or collected
data. When a dependency or native code starts using another API from Apple's
list, add its category, then check the built bundle:

```bash
nm -u "PATH_TO_APP/Fluux Messenger iOS Dev" | grep -E '_(f?stat(at)?|lstat|statv?fs|getattrlist|mach_absolute_time)$'
```

## Mobile capabilities and limitations

The iOS host uses the responsive React interface and connects over WebSocket
(`wss://` with a valid certificate) or through the native TCP/TLS proxy, which
validates certificates with Apple's system trust policy.

What runs natively:

- **Keychain.** The password, the FAST token and the secret that unlocks the
  OpenPGP key are kept in the iOS keychain under the service
  `net.processone.fluux`, accessible after first unlock and never synced to
  other devices. A FAST token found in browser storage is moved to the keychain.
- **OpenPGP.** The same Sequoia engine as the desktop. The key is unlocked from
  the keychain at login, so no passphrase is asked per session, and key
  rotation is available.
- **Notifications.** Local notifications go through the OS. Remote push uses
  APNs and XEP-0357 (see [Remote push notifications](#remote-push-notifications)).
  The app icon badge counts unread conversations, and a conversation's
  notifications are removed once it is read.
- **Files and media.** Uploads, downloads and the media cache run in Rust, as
  on the desktop. Received files are saved or shared through the system share
  sheet, which offers Photos and Files.
- **Link and text previews.** Open Graph metadata and text file previews are
  fetched natively, so they are not subject to CORS.
- **Sharing.** Links, images and documents shared from other apps (see
  [Receive a shared link, document, or image](#receive-a-shared-link-document-or-image)).
- **`xmpp:` links.** The app registers the `xmpp` URL scheme. A link opens the
  conversation, or prefills the login screen when no account is connected.

Not available yet:

- **Background connection.** iOS suspends the app in the background and the
  connection drops. A push only shows a notification; messages are fetched
  when the app returns to the foreground. Do not treat the app as an
  always-connected client.
- **Notification actions.** There is no reply or mark-as-read from a
  notification.
- **Away on background.** Presence does not switch to away when the app goes
  to the background.
- **Distribution.** There is no TestFlight or App Store build.

Validate on a device before trusting a build with existing accounts or keys.

## Troubleshooting and validation

- **No simulator found / ambiguous selection:** use a UDID from
  `xcrun simctl list devices available`, or boot exactly one simulator before
  running the simulator command without an argument.
- **No signing team / provisioning profile:** check the Apple Account, target's
  development team, device registration and automatic signing in Xcode.
- **Device unavailable:** check Developer Mode and Xcode support for its iOS
  version. Successful signing does not imply these requirements are satisfied.
- **Page fails to load with hot reload:** inspect Tauri's host address and the
  Mac's firewall/network access to port 5173 (5194 for the live demo).
- **Swift runtime link errors with Xcode 27:** verify `llvm-tools`, the checked-in
  Cargo lockfile and `.cargo/config.toml`; rebuild the iOS target after updates.
- **TLS failure:** check the certificate chain and XMPP domain, not only the
  TCP endpoint name. The proxy validates through Apple's system trust policy.

Check launch, login, message send/receive and reconnection on the target device.
Exercise both WebSocket and native TCP/TLS proxy connections. Simulator success
is not physical-device proof, and successful foreground login does not prove
background delivery. Record build, installation and connection results separately.

For changes to the native host, run `cargo test --locked` and
`cargo clippy --locked -- -D warnings` from `apps/fluux/src-tauri`; icon
preparation has its own `npm run test:ios-icons` check. See also
[Tauri mobile prerequisites](https://v2.tauri.app/start/prerequisites/#ios).

## Receive a shared link, document, or image

Re-run `npm run tauri:ios:init` after adding or updating the sharing plugin.
The checked-in `src-tauri/mobile/ios/project.yml` is a custom Tauri XcodeGen
**template**, based on CLI 2.11.5; keep its upstream sections in sync when
upgrading the CLI. It embeds `FluuxShare` and gives both targets the App Group
`group.<application identifier>.share`. The development and demo identities
therefore have separate inboxes. Enable this App Group for both identifiers
and regenerate both provisioning profiles when signing for a physical device.

From Safari, Photos, or Files, choose **Share → Fluux**. The extension saves
the import and opens Fluux, which shows the picker at once (after sign-in if
necessary). Choose a contact or a joined room, review the content, optionally
edit its text, then press Send: Fluux opens the conversation. Cancel, or closing
the picker, discards the import. Nothing is uploaded by the extension, and
existing conversation drafts are untouched. An import not yet sent or cancelled
survives app restarts and opens again with Fluux, while unsent edits in the
picker are session-local. An upload or send failure keeps the import available.

The extension opens Fluux through the app's own URL scheme, its identifier
(`net.processone.fluux`, or `net.processone.fluux.demo` for the demo), declared
as a deep-link scheme in the Tauri config. iOS offers share extensions no API to
open their app, so the extension calls `openURL:options:completionHandler:` on
the `UIApplication` in its responder chain. If that fails, it keeps the saved
confirmation and the import waits until Fluux is opened.

This first version accepts one link or one file per share, up to 20 MiB per file
and 20 pending imports. Multi-file selections are not advertised. The normal
server upload limit still applies. Imports belong to this installed app, not
to a particular XMPP account: the user chooses the recipient after signing in.
The extension cannot send messages itself.

Native strings are generated from the app's locale JSON by
`mobile-share-resources.mjs`, run before initialization and with icon preparation.
Do not edit `gen/apple` or the generated `mobile/ios/Resources` directory.

Validate Safari URLs, Photos images and Files documents with Fluux closed,
already running, and logged out. Also test cancellation, failed uploads,
restart before sending, account changes and an unsupported/oversize file.
`demo.html?tutorial=false&share=1` exercises the common picker with a mock inbox
without reading native storage or sending real messages.

## Remote push notifications

The `push` plugin (`apps/fluux/src-tauri/plugins/push`) asks for notification permission, registers with APNs and
returns `{ token, environment }` through `plugin:push|register`. The token can change between launches, so once
permission is granted the plugin registers again on every launch and emits each token it receives as a `token` plugin
event. The environment comes from the embedded provisioning
profile: `development` for builds installed from Xcode or `tauri:ios:install`, `production` for TestFlight and the App
Store, which embed no development profile. Both use the topic `net.processone.fluux`.

To check a device without the web UI, launch the installed app with the push diagnostic, then read the file in which
it records the outcome of its launch registration (it asks for permission first if it has never been granted):

```bash
xcrun devicectl device process launch --device <DEVICE_ID> --terminate-existing \
  --environment-variables '{"FLUUX_PUSH_PROBE":"1"}' net.processone.fluux
xcrun devicectl device copy from --device <DEVICE_ID> --domain-type appDataContainer \
  --domain-identifier net.processone.fluux --source Library/Caches/push-probe.txt --destination push-probe.txt
```

With the app in the background, send a notification straight to APNs with the team's APNs key, bypassing the XMPP
server:

```bash
node scripts/apns-test.mjs AuthKey_XXXXXXXXXX.p8 <KEY_ID> <DEVICE_TOKEN> development
```

APNs answers `HTTP 200` when the key, topic, token and environment match. iOS shows no banner while the app is in the
foreground.

### From the XMPP server to the device

After login, the app registers its APNs token with the push app server through the XEP-0050 command
`register-push-apns`: `pushgatedev.process-one.net` for the `development` environment, `pushgate.process-one.net` for
`production`. It then enables push on the user's server (XEP-0357) on every fresh session. The user's server must
advertise `urn:xmpp:push:0`.

The app server sends notifications with `mutable-content`. The `FluuxNotification` service extension then replaces the
title with the sender's name, read from `NotificationNames.json` in the App Group container, which the app keeps up to
date with the roster and the joined rooms. A contact shows its name. A room shows the room name as title and the
nick as subtitle, provided the app server keeps the occupant's resource in `from`. An unknown sender shows the local
part of its JID. Enable the App Group `group.net.processone.fluux.share` for the App ID
`net.processone.fluux.notification` as well, and regenerate its provisioning profile.

Tapping a notification opens its conversation. Once the app has reconnected and fetched the pushed message, the view
jumps to the first new message, unless the reader has scrolled in the meantime.
