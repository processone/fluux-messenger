# Simulator widget lab

An unsigned simulator journey for the iOS unread widget and the push extension's code. It builds the
production `FluuxWidgets` sources (`mobile/ios/Widgets`, `UnreadList.swift`, `SharedNotificationStore.swift`)
and the production `NotificationService.swift` with its dependencies into a minimal host app, with the
App Group entitlement embedded through `-sectcreate` (as `ios-share` does). No account, network or signing.

It proves, on a disposable simulator:

1. **Gallery add**: the widget is found in the Home Screen gallery and added at medium size.
2. **Rows and avatar**: the seeded conversation and its mirrored avatar show on the home screen.
3. **Row tap**: tapping the row opens the host with the `shortcut` link for the account and conversation.
4. **Push step**: the host runs the production `NotificationService.didReceive` in-process with a push from
   an unlisted conversation; the widget then shows the new row. `simctl push` is not used because the
   simulator never wakes a notification service extension (checked on iOS 26.5 and 27.0).
5. **Sign-out**: after the production sign-out writes (empty names, no list), the widget shows
   "Sign in to Fluux" and no row.
6. **Hourly re-read**: the list changes with no redraw request; the widget shows the change by itself about an hour
   later (the iOS timeline policy). This step waits up to 80 minutes, so it is skipped unless
   `FLUUX_WIDGETS_HOURLY=1` is set; `test:local` does not set it.

```sh
FLUUX_WIDGETS_RESULTS=/absolute/path/outside/project/widgets-results npm run test:ios-widgets
# with the hourly re-read step (about an hour more):
FLUUX_WIDGETS_HOURLY=1 FLUUX_WIDGETS_RESULTS=/absolute/path/outside/project/widgets-results npm run test:ios-widgets
```

Requirements: macOS, Xcode with an iOS simulator runtime, Python 3, XcodeGen. Override the runtime with
`FLUUX_WIDGETS_RUNTIME`. Results (build and test logs, `widgets.xcresult`, and `attachments/` with a
picture and springboard tree per step) go to the results folder. The runner creates and deletes only its
own simulator. `npm run test:local` plans this lab whenever widget, `UnreadList`, `NotificationService`
or push extension sources, or the lab itself, change. Labels are matched in English.

**Not proven here** (needs a real device): APNs waking the suspended extension, its memory limit, a
locked phone, iOS redraw rationing on a device, the host app's own routing from the link, and the signed build's
App ID, provisioning profile and App Group.
