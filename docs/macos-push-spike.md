# macOS APNs push spike (FLM-188, notarized build)

Spike branch only; not for merge. It measures whether Apple delivers a push alert to a
notarized Developer ID build while Fluux is hidden, the Mac sleeps, or Fluux has quit.

## What the spike adds

- `plugins/push/src/macos.rs`: reads `com.apple.developer.aps-environment` and the sandbox
  flag from the app's own signature, adds the three APNs callbacks to Tauri's app delegate
  with `class_addMethod`, and registers with Apple on the `plugin:push|register` command
  (same shape as iOS, so `useNativePush` is reused). Inert without a push entitlement.
- `push-spike.jsonl` in the app log directory: launch capabilities, registration result and
  every delivered notification with its delivery date, read at each launch.
- `FLUUX_MACOS_PUSH_ENV` / `FLUUX_MACOS_PROVISION_PROFILE` in `scripts/tauri-macos-share.mjs`
  add the push entitlements and embed the profile. The share extension builds as before.
- `VITE_MACOS_PUSH_SPIKE=1` turns `usesNativePush` on for macOS in the frontend build.

## Build (captain-only inputs: Developer ID identity, profile, notary credentials)

```bash
export VITE_MACOS_PUSH_SPIKE=1 FLUUX_MACOS_PUSH_ENV=production
export APPLE_SIGNING_IDENTITY="Developer ID Application: … (TEAMID)"
export FLUUX_MACOS_PROVISION_PROFILE=/path/to/Fluux_DeveloperID_Push.provisionprofile
npm run tauri build -- --config src-tauri/tauri.macos-push-spike.conf.json
```

Notarize and staple the result, then run the scenarios from FLM-188 in a disposable macOS user.
Decision rule: scenarios 4 and 5 show the alert within 60 seconds in 5 of 5 trials; scenarios
2 and 3 never show a message twice.

## Scenario options

- Scenario 10: launch the app with `FLUUX_PUSH_SPIKE_CLOSE_AT_SLEEP=1` (for example
  `open --env FLUUX_PUSH_SPIKE_CLOSE_AT_SLEEP=1 Fluux.app`). It closes the XMPP proxy link on
  `NSWorkspaceWillSleepNotification`; the existing wake handling reconnects.
- Scenario 11: `APNS_KEY_FILE=… APNS_KEY_ID=… APNS_TEAM_ID=… node apps/fluux/scripts/apns-direct.mjs <token-hex>`
  sends a priority 10 alert with a one-hour expiration to `net.processone.fluux`. The key is read from a file,
  never from the command line. Use it only after the captain consents to the team push key.
