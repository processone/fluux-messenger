# macOS communication notification investigation (#1386)

## Outcome and recommendation

This is a **development-only prototype**, not a migration. Normal development and
release builds continue to use the existing notification backend. Do not close
[issue #1386](https://github.com/processone/fluux-messenger/issues/1386) on the
strength of unit tests or compilation: installed native qualification remains
pending. Keep the current presentation until the installed checks below succeed
and a separate activation/privacy decision is made.

The accepted investigation correctly identified macOS API availability, but API
availability alone does not establish entitlement approval, presentation, click
routing or Focus behavior. None of those outcomes is claimed here.

## Activation and build boundaries

Both of these gates are necessary:

- Cargo feature `macos-communication-prototype` compiles the Objective-C bridge.
- The installed bundle must have identifier
  `net.processone.fluux.communication-prototype` and the generated
  `FluuxCommunicationPrototype` Info.plist flag.

`apps/fluux/src-tauri/tauri.communication-prototype.conf.json` supplies the separate
name **Fluux Communication Prototype**, identifier and native feature. The macOS
metadata generator adds `NSUserActivityTypes = [INSendMessageIntent]` and
`com.apple.developer.usernotifications.communication = true` **only** for this
configuration. Neither the production nor the Dev app acquires the entitlement.
No APNs entitlement, push registration, notification service extension, voice
Siri permission or Focus bypass entitlement is added. The existing macOS Share
Extension remains part of the application build; it is not required by the
communication-notification API itself.

For unsigned compilation (from the project root, after `npm ci`):

```sh
npm run build:sdk
npm run build:app
cargo test --locked --manifest-path apps/fluux/src-tauri/Cargo.toml --features macos-communication-prototype
node --test scripts/macos-communication.test.mjs
```

These commands do not install an application, inspect signing identities or
establish notification authorization. Do not use `tauri:install` for this
experiment: it targets the existing Dev application and its helper inspects
local signing identities. Do not run a signing helper against personal keychains.
Signing experiments require a disposable HOME and `FM3000_LOCAL_CODESIGN_DIR`
inside that HOME; a scratch HOME alone is not a promise that Apple signing tools
will avoid the login keychain, so an authorized signing owner must explicitly
configure the disposable signing environment.

A signing owner builds the new identity with Tauri's prototype config, **not**
the regular Dev override. The prototype config disables updater artifacts and
keeps the development TLS provider. For example, the Tauri build configuration
argument from `apps/fluux` is `--config src-tauri/tauri.communication-prototype.conf.json`.
The owner must merge the prototype's effective config when preparing bundle
metadata and verify that the final host contains the two declarations above.
Never replace an installed production or Dev app to test this prototype.

## Availability and signing assessment

| Item | Assessment | Qualification |
| --- | --- | --- |
| Native macOS communication content update | macOS 12 and later | Availability-checked; no calls before macOS 12 |
| Existing local notification path | Uses macOS 10.14 APIs; project still declares 10.13 | Minimum unchanged; this does not promise notifications on 10.13 |
| Intents, UserNotifications, AppKit | Linked only for the native prototype feature | Unsigned compile/contract tests, not installed proof |
| Communication Notifications capability | Requires Apple's capability-enabled App ID/profile and suitable signing | Not established by an ad-hoc or self-signed build |
| Developer ID | Apple's macOS capability matrix lists support | Captain's signing owner must verify the actual profile and signed bundle |
| Focus, Siri suggestions, clicks, system appearance | Controlled by macOS and the installed bundle | Pending interactive native evidence |

References: [Apple communication notifications](https://developer.apple.com/documentation/usernotifications/implementing-communication-notifications),
[content update](https://developer.apple.com/documentation/usernotifications/unnotificationcontent/updating(from:)),
[macOS capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-macos/),
[interaction lifecycle](https://developer.apple.com/documentation/intents/ininteraction).

## Initial unsigned verification

The local investigation ran on macOS 27.0 (26A428) with the macOS 27.0 SDK.
The application sources report version 0.18.0; no installed prototype was built
or launched. The task's review report records the exact local commit tested.

Passed checks include the executable Objective-C intent/delivery contracts,
locked Rust suites with default, prototype and production-TLS features, Clippy,
SDK/application suites, type checking, web builds, lint, platform contracts and
native configuration/generation guards. The existing unsigned Share regression
also passed in a disposable iOS 26.5 simulator; that is not macOS notification
evidence. Existing skipped/ignored tests are not runtime qualification.

No installed macOS notification, native click/read journey, signed entitlement,
profile, Siri suggestion or Focus result is claimed. macOS 12 and older systems
were not available for runtime testing. The supported-version assessment above
must therefore remain separate from these automated results.

## Data and delivery contract

The frontend supplies structured sender and conversation fields, never a parsed
display title. Direct messages identify the contact independently of unread-count
suffixes. Rooms carry the sender nick, room name, own nick and last-known occupancy.
Like the iOS model, recipients exclude the sender and current user. If either is
absent from occupancy, the prototype uses the existing presentation instead of
inventing participants. A room avatar describes the conversation, never its
sender. XMPP occupant IDs provide stable sender/recipient identities where available.
Without them, nick-scoped identities change when a nick changes; they are not
claims about a real-world person's identity.

The native preparation command reserves the full account/conversation/message
identifier before asynchronous work. It queries delivered history, donates an
incoming interaction, then transforms the complete base content. Donation or
transformation failure selects the fallback **before** scheduling. The frontend
then re-resolves the live message and rechecks account generation, unread state,
retraction, preview edits, permission, mentions/room eligibility and Fluux DND.
Only a still-eligible token is committed. When preparation returns `null`
(disabled prototype, unsupported system or incomplete identity), the caller uses
legacy posting without this additional eligibility check.
Read/account cleanup also cancels native preparations. Apple's successful
transformed result is forwarded without mutation.

Each token can schedule once. A scheduling error never triggers a second add,
because an attachment error can accompany successful delivery. Repeated and
concurrent copies of a reserved/attempted message are suppressed. Delivered
history prevents replacing that same notification after relaunch. This is not a
permanent replay ledger after a notification has been removed; the live unread
policy still owns that case. At 4096 entries, the development-session ledger
returns new identities to the legacy path instead of dropping all later alerts.
Already attempted or pending identities remain suppressed, including at capacity.
New legacy-path messages no longer receive the prototype's deduplication guarantee;
no stored identity is evicted to make room. Unused
tokens expire after 30 seconds; a commit after expiry is dropped. Preparation
waits up to two seconds each for history and donation. An unavailable history
answer drops the alert rather than risking a repeat; a donation timeout selects
the fallback, and a late donation never schedules anything.

The enriched image is validated and loaded into memory. Fallback attachments
receive independent, private temporary copies; the cached source is never moved.
Copies are removed on the single scheduling completion. Missing/invalid avatars
preserve text. Click routing uses the existing serialized navigation identifier
including account and message. Read dismissal queries OS-delivered history as
well as the process-local index, preserving account boundaries after restart.
The existing frontend filters and sound preference remain authoritative. The
macOS backend continues to set no system sound; this prototype does not introduce
an additional alert tone or interruption level.

## Privacy inventory and cleanup

Use **only isolated test data** while the feature is enabled.

| Field | Notification center | Donated interaction / Intents |
| --- | --- | --- |
| Account/contact/room addresses and message ID | Existing click-routing identifier and userInfo | SHA-256 of length-delimited JSON identity tuples; not raw addresses |
| Sender display name | Existing title | Sender display name |
| Room display name | Existing title | Speakable group name |
| Room participants | Not added to the preview | Other occupants' nicknames and account/room-scoped hashed handles |
| Sender/room avatar | Fallback file attachment if needed | Validated in-memory person/group image |
| Message preview | Existing body | `content: nil` on the intent; no donated message body |
| Conversation identifier | Opaque thread identifier | Account-scoped hashed group identifier |

Hashes are deterministic pseudonyms, **not anonymization**: known addresses or
nicknames can be guessed. macOS still sees existing notification content/routing.
Interactions may feed Siri, suggestions and Focus classification. An absent
intent body minimizes disclosure but its installed appearance/usefulness is an
experiment, not an established result. No Contacts lookup or upload is added.

The prototype deliberately retains hashed handles without `contactIdentifier`.
This may prevent macOS from recognizing a sender selected in a person-based Focus
allowlist. Record that expected recognition limitation, not a successful Focus
qualification. No raw-JID variant or personal-Contacts lookup is added.

The prototype saves only its opaque account-to-donation-group registry in its
own bundle's preferences (`FluuxCommunicationPrototypeGroups`). This permits
cleanup after relaunch; it stores no previews, names or avatar bytes. macOS owns
donated interaction retention; the prototype does not promise a deletion time.
Reading a conversation requests deletion of its group; account change/logout
requests deletion of the previous account's registered groups. A late successful
donation after cancellation requests deletion of that interaction alone, so it
does not remove a newer message's donation. Deletion is best-effort;
the registry remains so cleanup can be retried. Only this separate prototype's
groups are deleted, never all Siri interactions or another application's data.

## Configuration probe and merge boundary

`npm run check:tls-build` exercises the installed Tauri CLI's real configuration
merge and records its native feature arguments with a runner that stops before
compilation, bundling or signing. On macOS, it passes those effective overrides
to the real metadata generator in a disposable fixture and checks the generated
prototype flag, communication entitlement and activity declaration. It also
checks that the prototype selects only its native feature, not production TLS.
This is generated-configuration evidence, not signed installed qualification.
The macOS native CI job runs this probe alongside the native contracts, feature
Cargo tests and Clippy.

Keep `Refs #1386`, not `Closes #1386`, while signed installed proof is pending.
All pull request checks, including the macOS native job on the submitted version,
must pass before a merge is proposed. Passing them does not close the investigation.

## Installed verification required from the captain

### Signing setup

An authorized owner must provide a signed **Fluux Communication Prototype** bundle
built from the reviewed commit, with:

1. An Apple Developer team and Communication Notifications enabled for explicit
   App ID `net.processone.fluux.communication-prototype`.
2. Suitable Apple Development or Developer ID Application signing and the matching
   capability-enabled provisioning profile embedded where Apple's distribution
   method requires it. An ad-hoc/self-signed signature is not entitlement proof.
3. A separately identified, correctly signed existing Share Extension and matching
   App Group for this prototype if the normal bundle includes that extension.
4. Recorded signed host entitlements, profile approval, final Info.plist,
   application version/commit, macOS version and signing verification result.

For step 2, the authorized signing owner embeds the matching host profile by
adding a second configuration override to the prototype build. From `apps/fluux`:

```sh
npm run tauri -- build \
  --config src-tauri/tauri.communication-prototype.conf.json \
  --config '{"bundle":{"macOS":{"files":{"embedded.provisionprofile":"<path>"}}}}'
```

Replace `<path>` with the selected profile's absolute file path; it is not a
certificate or private-key path. Tauri copies it to
`Fluux Communication Prototype.app/Contents/embedded.provisionprofile`. The signing
owner must verify that the embedded profile matches the isolated App ID/team,
authorizes Communication Notifications, and accompanies the expected signed
entitlements. Copying a profile alone does not prove entitlement approval.
Use only the isolated signing environment described above; this is not a command
for the automated contract tests or a request to use personal signing material.

Do not send private keys, certificate passwords, session passwords or tokens in
a task reply. Use the captain's authorized signing workflow in an isolated runner.
No signing material or native account access is assumed by the automated tests.

### Test account and room

Provide a new test-only XMPP account on a controlled server, a second account as
its direct-message sender, and a room joined by both plus a third test occupant.
Record their **non-secret JIDs**, the room JID and each nick in the test report.
Use a second recipient account for account-switch isolation. All names, messages,
images and server data must be disposable. Supply an isolated macOS user/profile
with no personal Fluux accounts or Siri history. The captain signs in locally;
credentials never enter a card or evidence artifact.

### Interactive checks and retained evidence

Before enabling the prototype, capture the same isolated direct and room alert
states on the current notification path. Keep size/theme/account data fixed.
Install only the new prototype app, grant notifications and record:

1. Direct and room messages with valid, absent and invalid avatars. Keep pictures
   of each result and verify the room image is not presented as the occupant.
2. Multiple different messages, a replay of the same message, concurrent arrivals,
   and forced donation/transformation failures through the automated contract
   harness. Check delivered history shows one add per eligible message, no resend.
3. Click direct and room alerts while warm and after quitting/relaunching. Record
   the correct account, conversation and message being selected.
4. Mark read locally and from another client, including while preparation is in
   flight and after relaunch. The account's alerts disappear; a different account's
   alerts remain. Record the click/read journeys, not only their final screens.
5. Switch accounts/logout during preparation, then replay old data. No old-account
   alert appears. Repeat account cleanup after relaunch.
6. Deny notification permission, toggle mention-only versus all-room notifications,
   enable Fluux DND, and toggle sound. Confirm existing policy and sound behavior.
7. With macOS Focus disabled and enabled, record delivery with the test person
   allowed and disallowed. Record sender recognition as an expected limitation
   of the hashed handles; do not mark person-based Focus qualification as passed.
   Do not request a bypass or force interruption.
8. Record whether nil intent content and hashed handles preserve useful native
   appearance; inspect only the isolated prototype's suggestions/interaction data.

Record every tested OS version explicitly. A macOS 27 test does not qualify
macOS 12 or an older release. Older-system tests, signing/profile approval,
installed appearance, native clicks and Focus remain **not verified** until an
owner supplies their evidence. Compilation and simulated OS callbacks cannot
substitute for those results.

Out of scope: automatic activation, iOS changes, APNs, voice commands, inline
reply and non-message alerts.
