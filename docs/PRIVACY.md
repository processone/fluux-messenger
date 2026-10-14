# Fluux Messenger privacy policy

[Version française](PRIVACY.fr.md)

Effective date: **1 October 2026**

This policy covers Fluux Messenger for iOS, desktop and the web. Fluux is an
XMPP client developed by ProcessOne. You choose your XMPP account and server;
ProcessOne does not operate that server as part of Fluux. ProcessOne operates
the optional iOS push notification service described below.

Policy operator: **ProcessOne SAS, 168, rue Saint-Denis, 75002 Paris (France)**.
Privacy contact: **[contact@process-one.net](mailto:contact@process-one.net)**.

## Your account and communications

Fluux connects to your chosen XMPP server to authenticate and exchange messages,
files, contact information, avatars, presence and account settings. That server
and the servers of your contacts or chat rooms handle the communications you
send. Their operators determine their own storage and retention practices;
ask your XMPP provider about its privacy policy and account deletion.

OpenPGP encryption is available for one-to-one chats. When used, message content
and encrypted attachments are encrypted on your device before transmission;
account and routing information still reach the servers. Group chats are not
OpenPGP encrypted. Public keys and synchronized settings are published to your
XMPP account; if you choose server key backup, the private-key backup is
encrypted before it is uploaded to your XMPP server.

## Optional iOS push notifications

Push notifications require iOS notification permission and support from your
XMPP server. The push setting starts enabled: when permission is granted and
server support is available, Fluux can register automatically. You can turn
push off in **Settings → Notifications** and continue using the app.

During registration, Fluux sends the APNs device token and a randomly generated
installation identifier to ProcessOne's push service through your authenticated
XMPP connection. Your XMPP server supplies your account identity with that
request. The service associates the token with your bare JID (your account
address without its device/resource suffix), and returns a push node and,
where supplied, a registration secret. Fluux passes those registration details
to your XMPP server so it can request notifications for your device. Registration
is renewed on a fresh session or a changed token while push remains enabled.

Production builds use `push.fluux.io`; development builds use
`pushdev.fluux.io`. These identifiers are used for notification
delivery, consistent with the iOS privacy manifest's device ID and user ID
categories, linked to the user for app functionality.

Your XMPP server supplies the notification payload that ProcessOne forwards
through Apple's Push Notification service (APNs). Depending on that server,
the payload can include the sender's address and notification text or a message
summary. Do not assume that push payloads contain no communication information.
OpenPGP preview decryption, described below, happens on the device; Fluux does
not send that decrypted preview back to ProcessOne.

Turning push off while connected asks your XMPP server to stop sending
notifications to this device's registered node. After success, Fluux removes
the locally saved registration and token. This does not send a deletion request
to ProcessOne's push service. Logout disconnects the account and clears login
credentials, but does not explicitly send the push-disable request; clearing
local account data also does not delete the push-service record. Disable push
while connected before logging out if you want to request that delivery stops.
Deleting local data does not delete your XMPP account.

The push service is hosted in France by OVH. It stores only the device token
and your bare JID, together. It deletes both when Apple's push service reports
that the token is no longer valid, for example after uninstalling the app when
a later push attempt reveals this. Otherwise, it stores them for at most one
year after their last use.

## OpenPGP notification previews on iOS

This separate per-account option is off by default. Enabling it makes unlocked
decryption subkeys, public-key/trust information and an account login credential
available locally to the notification extension in a dedicated shared keychain
group. The snapshot is restricted to this device and accessible after its first
unlock. It is removed when you disable previews, log out or change accounts.

The extension briefly connects to your XMPP server over TLS, authenticates and
fetches recent entries from your account's message archive for the sender. It
verifies and decrypts eligible encrypted messages locally, and can show the text
of an unencrypted one, without publishing presence or read markers. It uses locally cached names and avatars; it does not
download notification avatars. A local ledger keeps message identifiers and
notification/read state, without message bodies or secrets. Entries older than
seven days expire during subsequent ledger activity, so they can remain longer
while the ledger is inactive. Opting out, logout or an account change purges it.

Previews follow iOS **Show Previews**. **Always** can display decrypted text on
the lock screen after the first unlock; **Never** skips preview decryption.
Missing credentials or keys, or failed verification/fetching, can leave a
generic notification. Preview text is handed to iOS for notification display.

## Data kept on your device

Fluux keeps preferences, drafts, account/session information, contact and room
data, message history, search indexes, avatars and downloaded media in local
storage, IndexedDB, browser caches or native app files. Local message and media
caches can contain decrypted content. Some preferences and encryption trust
settings also synchronize through your XMPP server.

On iOS and supported desktop platforms, remembered login credentials use the
system credential store. Session credentials also use session storage. Native
OpenPGP keys use app files and keychain protection where available; some desktop
systems without a working keychain use a local file fallback with an in-app
warning. Web OpenPGP keys use IndexedDB. These local stores are not uploaded to
ProcessOne's push service.

Logout offers a choice to retain or clear local data. Clearing account data
does not erase every shared avatar/media cache or OpenPGP key; key deletion has
its own encryption-settings controls. Copies on servers or recipients' devices
are outside local cleanup. On iOS, Fluux also supplies conversation identities,
names and cached images to the system for notification display and share
suggestions.

## Other network requests

- **Files and media:** uploads go to the HTTP upload service discovered through
  your XMPP server. It receives file bytes and upload metadata; encrypted uploads
  use encrypted bytes and a generated filename. Downloads, remote avatars and
  preview images can contact hosts identified by your server or message content.
  Those hosts can see your network IP address and the requested URL. Media
  autoload settings control supported incoming media loads.
- **Link previews:** on iOS and desktop, sending an eligible unencrypted message
  containing a link can fetch that site's Open Graph metadata directly from your
  device. The linked site (and any redirect destination) can see your IP address
  and requested URL even if you do not open the link. Extracted metadata is sent
  to the conversation through XMPP. The web app does not perform this native
  metadata fetch, but may load preview images received in messages.
- **Web notifications:** optional browser push registers a subscription endpoint
  and its encryption/authentication keys with your XMPP server, using the service
  it advertises and the browser's push provider, rather than the iOS APNs
  registration described above.
- **App delivery and updates:** the web host receives requests for the app and
  its assets. Supported desktop update checks and downloads contact GitHub
  release infrastructure. These services can see your IP address and request
  information. Store distribution and TestFlight are provided by Apple under
  Apple's own privacy terms.
- **Desktop automation:** if you enable the local MCP interface and give another
  program its access token, that program can list conversations, read message
  history (including decrypted text) and send messages. The interface is off by
  default; the program you connect controls any subsequent use of that data.

## Analytics, advertising and privacy requests

Fluux includes no advertising or analytics service, remote telemetry reporting,
or automatic crash-reporting integration. It does keep local diagnostic logs
and an XMPP console, which can contain account or communication information.
You can export diagnostic information yourself; review it before sharing.

For requests concerning ProcessOne's push-service data, contact the privacy
address above. For messages, uploads or account records held by your chosen
providers, contact those providers.
