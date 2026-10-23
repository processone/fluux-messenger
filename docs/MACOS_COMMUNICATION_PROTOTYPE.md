# macOS communication notification test mode (#1386)

## Outcome and recommendation

The communication path is an **explicit test mode on the ordinary
`net.processone.fluux` identity**, disabled by default. There is no third app
identity or dedicated prototype configuration. Ordinary release builds and
`net.processone.fluux.dev` keep the current notification path and updater.
F5's current-name behavior, eligibility checks, replay protection and fallback
remain in the test mode. This is not automatic production activation.

Keep `Refs #1386`, not `Closes #1386`: signed installed appearance, clicks,
profile approval, older-system behavior and Focus remain unverified. The captain
reported that the standard App ID already has the capability; this does not
establish that the profile selected for signing actually authorizes it. The
previously downloaded third-identity profile cannot authorize this bundle and
must not be installed for this test. No portal records need to be deleted.

## Activation and build boundaries

All of these gates are necessary:

- The optional Cargo feature `macos-communication-test` compiles the native bridge.
- The standard identity is `net.processone.fluux`; Dev is excluded even if someone
  explicitly passes that feature while using the Dev override.
- The generated `FluuxCommunicationTest` Info.plist flag must be true.

Enable the feature in Tauri's **effective configuration**, not merely a standalone
Cargo argument when packaging. The metadata generator uses that configuration to
add `NSUserActivityTypes = [INSendMessageIntent]`, the restricted communication
entitlement and, when the team is known, its application/team signing identifiers.
Ordinary standard/Dev builds do not acquire these declarations. The host injects
an immutable early test marker only for macOS + standard identity + explicit
feature. Without it, frontend callers skip roster enumeration and preparation.

No APNs entitlement, push registration, notification service extension, voice
Siri permission or Focus bypass entitlement is added. The existing Share
Extension remains part of the regular app build, not a communication requirement.

For unsigned, isolated automated checks after dependency setup:

```sh
cargo test --locked --manifest-path apps/fluux/src-tauri/Cargo.toml --features macos-communication-test
node --test scripts/macos-communication.test.mjs
npm run check:tls-build
```

These checks neither sign nor install an app. Do not use `tauri:install`: it
replaces the existing Dev app and its helper inspects local signing identities.
Do not run signing helpers against personal keychains. Future signing requires
an authorized owner, a disposable HOME with `FM3000_LOCAL_CODESIGN_DIR` inside it,
and an explicitly isolated signing keychain; a scratch HOME alone is insufficient.

## Updater protection during the test

Only the explicitly enabled standard-identity macOS test omits the native updater
plugin. The same immutable communication-test marker makes existing capabilities
hide Updates and block automatic/manual checks, prompts and installation. Ordinary
standard and
Dev builds retain their updater and normal capabilities. There is no exception
based on a third identity.

`createUpdaterArtifacts: false` prevents artifact generation only; it does not
block release-feed checks or installation. The runtime test-mode guard provides
that protection. The inline signing-owner example below also disables updater
artifact generation and retains the standard production TLS feature.

## Availability and signing assessment

| Item | Assessment | Qualification |
| --- | --- | --- |
| Native macOS communication content update | macOS 12 and later | Availability-checked; no calls before macOS 12 |
| Existing local notification path | Uses macOS 10.14 APIs; project still declares 10.13 | Minimum unchanged; this does not promise notifications on 10.13 |
| Intents, UserNotifications, AppKit | Linked only for the native test feature | Unsigned compile/contract tests, not installed proof |
| Communication Notifications capability | Requires Apple's capability-enabled App ID/profile and suitable signing | Not established by an ad-hoc or self-signed build |
| Developer ID | Apple's macOS capability matrix lists support | Captain's signing owner must verify the actual profile and signed bundle |
| Focus, Siri suggestions, clicks, system appearance | Controlled by macOS and the installed bundle | Pending interactive native evidence |

References: [Apple communication notifications](https://developer.apple.com/documentation/usernotifications/implementing-communication-notifications),
[content update](https://developer.apple.com/documentation/usernotifications/unnotificationcontent/updating(from:)),
[macOS capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-macos/),
[interaction lifecycle](https://developer.apple.com/documentation/intents/ininteraction).

## Verification limits

Executable Objective-C contracts inject OS delivery/donation effects. Real Tauri
configuration probes stop before compilation, bundling and signing. Unit and
compile results are not installed evidence. The task report records exact
commands, versions, feature selections and commits; the new standard-identity
mode requires its own reviewed version and every final PR check.

No installed standard-identity test bundle, actual signed entitlement/profile,
native click/read journey, Siri suggestion or Focus result is claimed here.
A macOS 27 compile/test does not qualify macOS 12 or older systems at runtime.

## Data and delivery contract

The frontend supplies structured sender and conversation fields, never a parsed
display title. Direct messages identify the contact independently of unread-count
suffixes. Rooms carry the sender nick, room name, own nick and last-known occupancy.
Like the iOS model, recipients exclude the sender and current user. If either is
absent from occupancy, the test mode uses the existing presentation instead of
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
Only a still-eligible token is committed. If only a contact or room display name
changed during preparation, finalization refreshes the transformed
content with that current name before its one scheduling decision. Other
message/sender identity or preview changes still cancel. Room occupancy changes
alone do not cancel: the donation retains its prepared participants and participant
IDs. The reservation stays cancellable during the refresh, and unread-count growth remains eligible. The
existing donation represents the same event/person; refreshing presentation does
not add another asynchronous donation window after eligibility validation. When preparation returns `null`
(disabled test mode, unsupported system or incomplete identity), the caller uses
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
New legacy-path messages no longer receive the test mode's deduplication guarantee;
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
macOS backend continues to set no system sound; this test mode does not introduce
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

The test mode deliberately retains hashed handles without `contactIdentifier`.
This may prevent macOS from recognizing a sender selected in a person-based Focus
allowlist. Record that expected recognition limitation, not a successful Focus
qualification. No raw-JID variant or personal-Contacts lookup is added.

The test mode saves only its opaque account-to-donation-group registry in the
standard app's test-user preferences (`FluuxCommunicationTestGroups`), with opaque
IDs prefixed `fluux-communication-test-`. This permits cleanup after relaunch;
it stores no previews, names or avatar bytes. macOS owns
donated interaction retention; the test mode does not promise a deletion time.
Log out and perform cleanup with
the test-enabled build before returning that test user to an ordinary build.
Reading a conversation requests deletion of its group; account change/logout
requests deletion of the previous account's registered groups. A late successful
donation after cancellation requests deletion of that interaction alone, so it
does not remove a newer message's donation. Deletion is best-effort;
the registry remains so cleanup can be retried. Only the recorded test-mode
groups are deleted, never all Siri interactions or another application's data.

## Configuration probe and merge boundary

`npm run check:tls-build` exercises the real installed Tauri configuration merger
with a runner that stops before compilation, bundling or signing. The standard
opt-in override adds only `macos-communication-test` to the standard TLS features,
keeps the existing identifier/name, and generates the expected flag, activity,
entitlement and team/application identifiers. Ordinary standard and Dev negative
contracts remain required. CI also runs native contracts and feature tests/Clippy.

Keep `Refs #1386` while installed proof is pending. Every final-version PR check,
including default-feature, Windows/Linux and macOS native checks, must pass before
a merge offer. Passing them does not close the investigation.

## Future installed verification by an authorized owner

### Signing setup

No signing or installation is authorized by the implementation task. A future
owner must provide a reviewed signed standard-identity test bundle with:

1. Communication Notifications authorized for `net.processone.fluux` by the actual
   profile used for signing, not just enabled on the portal's App ID page.
2. A compatible signing certificate and matching provisioning profile embedded
   where required; ad-hoc/self-signed signatures do not establish entitlement approval.
3. The regular signed Share Extension and standard app's App Group, if included.
4. Recorded signed entitlements, profile approval, Info.plist, app commit/version,
   macOS version and signature verification results.

From `apps/fluux`, an authorized owner can use an inline override, without a
third identity or checked-in test configuration:

```sh
npm run tauri -- build \
  --config '{"build":{"features":["production-tls","macos-communication-test"]},"bundle":{"createUpdaterArtifacts":false,"macOS":{"files":{"embedded.provisionprofile":"<path>"}}}}'
```

`<path>` is the matching standard-identity profile's absolute path, not a key or
certificate path. It is copied into `Fluux Messenger.app/Contents/embedded.provisionprofile`.
Do not use the Dev override or the former third-identity profile. Verify:

- `com.apple.application-identifier` is `<Team ID>.net.processone.fluux`.
- `com.apple.developer.team-identifier` matches the profile's team.
- The communication entitlement and activity declaration are present and authorized.

The generator adds these signing keys only for the explicit test when its team
is known. Copying a profile is not approval. No private key, certificate password,
account password or token belongs in a task reply or evidence artifact.
Use a per-user test installation, never overwrite the everyday standard/Dev app.

### Test account and room

Provide a new test-only XMPP account on a controlled server, a second account as
its direct-message sender, and a room joined by both plus a third test occupant.
Record their **non-secret JIDs**, the room JID and each nick in the test report.
Use a second recipient account for account-switch isolation. All names, messages,
images and server data must be disposable. Supply a separate, disposable macOS
user with no personal Fluux accounts or Siri history. Installing or running this test mode in the everyday macOS user is ruled
out: it shares the release/Dev keychain
item (service `com.processone.fluux`, account `secrets-v1`). A separate application
name, data directory or disposable HOME alone does not isolate that keychain item.
The signing owner must also configure the isolated keychain environment described
above. The captain signs in locally; credentials never enter a card or evidence artifact.

### Interactive checks and retained evidence

Before enabling the test mode, capture the same isolated direct and room alert
states on the current notification path. Keep size/theme/account data fixed.
Only the authorized owner installs the test bundle in that separate user and records:

1. Quit the installed Fluux before opening the local test copy, so the test copy is the one that opens.
2. Direct and room messages with valid, absent and invalid avatars. Keep pictures
   of each result and verify the room image is not presented as the occupant.
3. Multiple different messages, a replay of the same message, concurrent arrivals,
   and forced donation/transformation failures through the automated contract
   harness. Check delivered history shows one add per eligible message, no resend.
4. Click direct and room alerts while warm and after quitting/relaunching. Record
   the correct account, conversation and message being selected.
5. Mark read locally and from another client, including while preparation is in
   flight and after relaunch. The account's alerts disappear; a different account's
   alerts remain. Record the click/read journeys, not only their final screens.
6. Switch accounts/logout during preparation, then replay old data. No old-account
   alert appears. Repeat account cleanup after relaunch.
7. Deny notification permission, toggle mention-only versus all-room notifications,
   enable Fluux DND, and toggle sound. Confirm existing policy and sound behavior.
8. With macOS Focus disabled and enabled, record delivery with the test person
   allowed and disallowed. Record sender recognition as an expected limitation
   of the hashed handles; do not mark person-based Focus qualification as passed.
   Do not request a bypass or force interruption.
9. Record whether nil intent content and hashed handles preserve useful native
   appearance; inspect only the isolated test mode's suggestions/interaction data.

Record every tested OS version explicitly. A macOS 27 test does not qualify
macOS 12 or an older release. Older-system tests, signing/profile approval,
installed appearance, native clicks and Focus remain **not verified** until an
owner supplies their evidence. Compilation and simulated OS callbacks cannot
substitute for those results.

Out of scope: automatic activation, iOS changes, APNs, voice commands, inline
reply and non-message alerts.
