# macOS communication notifications (#1386)

Released macOS builds enable communication notifications for `net.processone.fluux`.
The updater stays enabled, including automatic checks and Updates settings. Dev
(`net.processone.fluux.dev`), ordinary local builds and pull request builds do not
opt in. There is no in-app switch, as on iOS.

## Activation and release profile

The macOS release job alone passes `src-tauri/tauri.release-macos.conf.json`.
It selects `production-tls` and `macos-communication` and maps the public profile
`macos/net.processone.fluux.provisionprofile` to `Contents/embedded.provisionprofile`.
The gates remain macOS + standard identity + Cargo feature + generated
`FluuxCommunication` plist flag. An immutable `__FLUUX_COMMUNICATION__` startup
marker allows frontend communication preparation without disabling updates.

The generator refuses communication-enabled production configuration without a
mapped profile and known team. It decodes the public CMS profile without keychain
access and requires the exact app/team, communication entitlement, macOS all-device
distribution with no device list, certificates and at least five years remaining.
It does not sign anything. See [Release](RELEASE.md#macos-communication-profile-and-update-check).

No APNs registration, remote push delivery, notification service extension,
Contacts lookup, voice Siri permission, Focus bypass or inline reply is added.
The existing Share Extension, its signing and App Group remain unchanged. The
minimum deployment target stays 10.13; communication APIs are guarded for macOS 12+.
Existing notification permissions, mention/DND filters and sound rules still apply.
Keychain storage, shared release/Dev access and app data paths are unchanged.

## Rollout and proof boundary

The captain chose **stable 0.18.2 directly**, replacing the earlier beta-first plan.
They will test the correctly signed production-identity build locally and publish
only if it works. A Dev build or an ad-hoc/self-signed build cannot prove this path.
The existing release signing and notarization process stays in place.

**Signed 0.18.2 release proof remains a named gap**, accepted for implementation.
Reading the supplied profile proves its declarations, not a signed app launching.
The gap closes with real per-architecture signed/stapled update verification and
the captain's local test before publication. Automated contracts do not establish
installed appearance, Focus behavior, older-system behavior or absence of a new
permission/keychain prompt. Keep `Refs #1386` until the local test result is recorded;
do not claim `Closes #1386` based on compilation or mocks alone.

## Checks without signing or installing

```sh
node --test scripts/macos-share.test.mjs scripts/macos-release.test.mjs scripts/macos-communication.test.mjs
npm run check:tls-build
cargo test --locked --manifest-path apps/fluux/src-tauri/Cargo.toml --features macos-communication
```

The separate read-only signature probe uses an extracted public 0.18.1 archive:

```sh
FLUUX_MACOS_REFERENCE_APP="/absolute/path/Fluux Messenger.app" node --test scripts/macos-signature-read.test.mjs
```

When the verifier or public-signature probe changes, the macOS native workflow
downloads that public reference into temporary storage and verifies its pinned
SHA-256 before extraction. Unrelated changes and weekly runs do not download it.
The local selector checks `FLUUX_MACOS_REFERENCE_APP` before starting any work.
The probe runs the verifier's actual signature-display commands, parses XML and
the legacy requirement, and extracts a public DER certificate. It never signs,
looks up private identities, accesses keychains, launches or installs an app.
A missing local fixture is missing evidence, not a pass. This proves command
compatibility only; it does not close the signed 0.18.2 release proof gap.
The disposable-runner launch environment contains only explicit system paths,
locale and scratch storage locations; it inherits no release credentials.

The configuration probe exercises the real Tauri merger and metadata generator,
then stops before compilation, bundling or signing. Native contracts inject OS
effects. Verifier tests use stand-in signature/stapling readings and do not prove
real signed-archive acceptance. No test command above signs or installs an app.

The release verifier reads the exact uploaded update archive after signing and
before `latest.json` publication. It checks the strict signature, embedded profile
coverage and certificate membership, legacy designated requirement, stapled
notarization, activity declaration and ten-second executable survival where the
runner can execute that architecture. Unsupported execution is reported as missing
runtime proof, never a launch pass. It uses a disposable extracted copy and home,
stops its child, and removes scratch output. `--launch` is explicit and enabled
for disposable release runners; local archive-only verification never launches the app. A scratch HOME does not isolate the
system keychain; do not run a real app against personal accounts as an automated check.

## Data and delivery contract

The frontend supplies structured sender and conversation fields, never a parsed
display title. Direct messages identify the contact independently of unread-count
suffixes. Rooms carry the sender nick, room name, own nick and last-known occupancy.
Like the iOS model, recipients exclude the sender and current user. If either is
absent from occupancy, the communication path uses the existing presentation instead of
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
(disabled communication path, unsupported system or incomplete identity), the caller uses
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
New legacy-path messages no longer receive the communication path's deduplication guarantee;
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
macOS backend continues to set no system sound; this communication path does not introduce
an additional alert tone or interruption level.

## Privacy inventory and cleanup

Use disposable accounts and messages when collecting test evidence.

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
intent body minimizes disclosure but its installed appearance/usefulness still needs signed-app evidence. No Contacts lookup or upload is added.

The communication path deliberately retains hashed handles without `contactIdentifier`.
This may prevent macOS from recognizing a sender selected in a person-based Focus
allowlist. Record that expected recognition limitation, not a successful Focus
qualification. No raw-JID variant or personal-Contacts lookup is added.

The communication path saves only its opaque account-to-donation-group registry in the
standard app's preferences (`FluuxCommunicationTestGroups`), with opaque
IDs prefixed `fluux-communication-test-`. This permits cleanup after relaunch;
it stores no previews, names or avatar bytes. macOS owns
donated interaction retention; the communication path does not promise a deletion time.
Reading a conversation requests deletion of its group; account change/logout
requests deletion of the previous account's registered groups. A late successful
donation after cancellation requests deletion of that interaction alone, so it
does not remove a newer message's donation. Deletion is best-effort;
the registry remains so cleanup can be retried. Only the recorded communication
groups are deleted, never all Siri interactions or another application's data.

## Local test before publication

The captain chose a **local signed production build before tagging 0.18.2**.
Follow the [complete local-build recipe](RELEASE.md#local-signed-macos-test-before-tagging-0182)
on the candidate commit, including dependency/SDK setup and the existing Developer
ID identity/key prerequisites. The direct build invocation is:

```sh
env -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD \
  APPLE_TEAM_ID=8L55BDM864 \
  APPLE_SIGNING_IDENTITY='Developer ID Application: ProcessOne (8L55BDM864)' \
  npm run tauri --workspace=@xmpp/fluux -- build \
    --target aarch64-apple-darwin \
    --config src-tauri/tauri.release-macos.conf.json \
    --config '{"bundle":{"createUpdaterArtifacts":false}}' \
    --bundles app
```

Do not use `tauri:build`, `tauri:install` or the Dev override. The local wrapper
always selects Dev, which cannot exercise communication notifications. This
command uses the release overlay and the existing Developer ID key, with no CI
certificate import. It disables updater artifact generation only; it does not
remove the updater plugin. Quit the installed Fluux and open the signed app in
`apps/fluux/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/` without
installing it over the everyday app. It uses normal Fluux data and the shared
keychain item; it is not an isolated Dev test.

Record the local result before the captain tags the tested source. The existing
tag workflow stays unchanged and publishes automatically after its checks; it
will not wait for a manual test afterward. This document is not a claim that the
local signed build has run or that the signed/notarized archive gap is closed.
This implementation task does not authorize the worker to sign, inspect keychains,
install or publish. Never send private keys or passwords
in evidence. Use disposable XMPP data for test recordings. Releases no longer
require the prototype's separate-user rule; any use of personal data or accounts
still needs the owner's deliberate approval. A changed app name or scratch HOME
alone does not isolate the shared keychain item.

Check direct and room notifications with and without avatars, click routing,
read dismissal, account/logout cleanup, notification permission denied, mentions,
Fluux DND and sound preferences. Confirm Updates remains available. Record Focus
behavior with allowed/disallowed people as a limitation of hashed handles, not a
promise of Contacts-based matching. Record OS version and signed artifact identity;
a test on one macOS version does not qualify all older systems.

References: [Apple communication notifications](https://developer.apple.com/documentation/usernotifications/implementing-communication-notifications),
[macOS capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-macos/).
