# Native iOS image-share regression

This unsigned simulator journey exercises the production `ShareViewController.swift`
with real `NSItemProvider` representations of `assets/readme/fluux-logo.png`.
It uses a separate sender and an isolated receiver, no Fluux accounts or network.
The receiver reads the extension's actual shared inbox bytes, checks decoding and
reports the file name, MIME type, and ImageIO type to the UI test.

Requirements: macOS, Xcode with an iOS simulator runtime, Python 3, and XcodeGen.
Run from the project root, with results outside the working copy:

```sh
FLUUX_SHARE_RESULTS=/absolute/path/outside/project/share-results \
  bash scripts/native-tests/ios-share/run.sh
```

The default runtime is iOS 26.5. Override `FLUUX_SHARE_RUNTIME` with an installed
CoreSimulator runtime identifier to exercise another version. The runner creates
and deletes only its own simulator and temporary build directory. It disables
signing; it never invokes signing or keychain commands.

The shared activity selector waits until the activity exists, is enabled, and is
hittable before one tap. A cold share sheet can advertise its activity before it
accepts input; existence alone is not readiness.

The UIImage journey catches the archived-object bug (FLM-20); the encoded-PNG
journey checks that existing image file representations remain usable. Both
journeys require the real inbox payload to decode as a PNG with matching metadata.
The two image journeys dismiss the system Open confirmation if present and
explicitly activate the minimal receiver without relaunching it. A separate activation journey accepts
that confirmation when needed and requires the receiver to reach the foreground
without an explicit launch. **These journeys do not prove the physical
TestFlight build's behavior or sending through a real Fluux account.**

`npm run test:ios-extensions` additionally exercises XcodeGen's real output from
the production app's info block. Regenerating the project must retain the schemes
configured for mobile deep links, including the share extension's containing-app
scheme. This check runs in the iOS build workflow. It needs XcodeGen but no build
or signing.

For device launch diagnosis, the extension logs the selected responder, selector,
and Boolean result in the `ShareHandoff` category of its bundle identifier's log
subsystem. It logs no URL payload, photo path, or account information. A missing
handler still leaves the saved-import fallback available; iOS can require consent
before a successful custom-scheme handoff.
