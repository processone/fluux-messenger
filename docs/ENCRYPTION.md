# End-to-End Encryption

This guide explains how end-to-end encryption (E2EE) works in Fluux Messenger and walks you through enabling it, sharing your identity with contacts, backing up your key, and moving to a new device.

If you just want the short version: turn it on in **Settings → Encryption**, write down the backup passphrase the app shows you, and keep it somewhere safe. That's the one thing that — if lost — cannot be recovered.

## What end-to-end encryption means

When E2EE is on, the messages you send and receive are scrambled on your device before they leave it, and only the people in the conversation can read them. Your XMPP server relays the ciphertext but cannot decrypt it. Neither can anyone who intercepts the traffic between servers, nor an administrator with access to server logs.

Fluux uses **OpenPGP for XMPP**, standardised as [XEP-0373](https://xmpp.org/extensions/xep-0373.html) (often called *"OX"*). It is built on the same OpenPGP cryptography used by email tools like GnuPG, adapted to fit instant messaging.

## How it works, in plain terms

Each account has a **key pair**:

- A **public key**, which you publish to your XMPP server so contacts can look it up.
- A **secret key**, which stays on your device and never leaves it unencrypted.

When you send a message, Fluux encrypts it with your contact's public key and signs it with your secret key. When your contact receives the message, their client uses their own secret key to decrypt it and your public key to verify the signature. The message is authenticated (it really came from you) and confidential (only the recipient can read it).

Every key has a **fingerprint** — a long identifier (64 hex characters) that uniquely represents it. When you want to be sure you are really talking to the right person and not someone impersonating them, you compare fingerprints out of band (in person, over the phone, on a verified channel).

## Turning encryption on

1. Open **Settings → Encryption**.
2. Toggle **Enable OpenPGP encryption**.
3. Fluux generates a key pair for your account. This takes a few seconds — the app uses strong settings (Argon2id key derivation) so the work happens in the background.
4. Your public key is published to your XMPP server under [PEP](https://xmpp.org/extensions/xep-0163.html) so contacts can discover it automatically.
5. Your fingerprint now appears in the Encryption panel. You can copy it and share it with contacts as proof of your identity.

That is the full setup. You don't need to do anything per-conversation: as soon as a contact also has encryption enabled, Fluux starts encrypting messages to them automatically.

## Sending encrypted messages

Once encryption is on for both sides, you don't have to think about it:

- A **🔒 lock icon** appears above the message composer when Fluux can send encrypted to the person you are chatting with. The tooltip shows their OpenPGP fingerprint.
- If the contact has not published a key (they are on a client that doesn't support OX, or haven't turned it on), the lock is not shown and messages are sent using the server's transport encryption only.
- Encrypted messages include a small plain-text fallback body for clients that don't understand OX, so those clients at least see a hint that an encrypted message was sent.

## Trusting a contact's key

The first time Fluux sees a contact's key, it trusts it automatically — a model called **Trust On First Use (TOFU)**. This is convenient and safe in most situations, but it cannot catch a deliberate impersonator who slipped a fake key in before you first spoke.

To be certain, **verify** the fingerprint:

1. Ask your contact for their fingerprint over a channel you already trust (in person, a phone call, a signed email).
2. Compare it to the fingerprint Fluux shows for them.
3. If they match, the key is verified.

Verifying only has to be done once per contact per key.

## Using encryption on several devices

If you log into Fluux on another device — a second laptop, the web client, a new phone down the line — that device does not automatically have your secret key. Without it, the new device cannot decrypt messages sent to you.

Fluux solves this with an **encrypted server backup** of your secret key, defined by XEP-0373 §5.

### Backing up your key

1. In **Settings → Encryption**, click **Back up**.
2. Fluux generates a **backup passphrase** — eight random words drawn from a [diceware](https://en.wikipedia.org/wiki/Diceware) list (88 bits of entropy, very strong).
3. **Write it down** or save it in a password manager. Confirm with the checkbox that you have stored it.
4. Fluux encrypts your secret key with this passphrase and publishes the encrypted blob to your XMPP server under a private PEP node that only you can read.

The passphrase never leaves your device and is never sent to the server. Only the encrypted blob is.

### Restoring on a new device

1. Log into Fluux on the new device with the same XMPP account.
2. Open **Settings → Encryption**. Fluux detects the backup on the server and prompts for the passphrase.
3. Enter the eight words. Fluux downloads the encrypted blob, decrypts it locally, and installs your secret key.

From that point on, the new device can read your encrypted history and send encrypted messages under the same identity.

### What happens if you lose the passphrase

**It cannot be recovered.** Not by Fluux, not by your server administrator, not by anyone. If you lose the passphrase and you don't have a device that still holds the secret key, the only option is to generate a new key pair. You will keep your account, but:

- Messages encrypted to your old key will no longer be readable.
- Contacts will see that your fingerprint changed and will need to re-verify.

Treat the backup passphrase like the recovery phrase of a cryptocurrency wallet: write it down, store it somewhere durable, and do not rely on memory alone.

## Encrypt-to-self and message history

When you send an encrypted message, Fluux also encrypts a copy to **your own key**. This is what lets other devices you own — and message replays from the server's [Message Archive](https://xmpp.org/extensions/xep-0313.html) — decrypt your outgoing history. Without it, you could send a message from your laptop and never be able to read it back on your phone.

## Where your key lives

| Where                        | What is stored                                                                           |
|------------------------------|------------------------------------------------------------------------------------------|
| Your device (desktop)        | Secret key, encrypted with a random per-device passphrase held in the OS keychain        |
| Your device (web)            | Secret key in memory only, loaded after you type the backup passphrase — never persisted |
| Your XMPP server (optional)  | Secret key encrypted with your backup passphrase; public key published for contacts      |
| Your contacts' devices       | Your public key, so they can encrypt messages to you                                     |

On Linux and Windows the secret key falls back to a file with restricted permissions if the OS keychain is unavailable.

## What encryption does — and doesn't — protect

**Protected**

- Message content (text, formatting, replies) while in transit.
- Message content stored on your server's archive.
- Message content stored at your contact's server.

**Not protected**

- **Metadata**: who you talk to, when, and how often. XMPP routing information is always visible to the server.
- **Group chats** (multi-user rooms): the current OX implementation covers one-to-one conversations only.
- **Compromised devices**: if someone can read your device's storage and the OS keychain, they can decrypt your messages. Use full-disk encryption.
- **Lost backup passphrase**: see above. There is no recovery side channel.

## Frequently asked questions

**My contact's lock icon is not showing.**
Their client either doesn't support OpenPGP for XMPP, or they haven't enabled it. Nothing you can do from your side — ask them.

**I see "OpenPGP" above a fingerprint in tooltips. What is that?**
It's just a label so the fingerprint's purpose is clear. The number below it is the actual fingerprint you compare.

**Can I turn encryption off for one conversation?**
Not currently. Encryption is enabled per account. If your contact's client supports OX, messages to them are encrypted.

**I reinstalled Fluux and lost my key. What now?**
If you had published a backup, restore it: open Settings → Encryption and enter the backup passphrase. If you had not, generate a new key — your old encrypted messages will no longer be readable.

**Will this work with OMEMO?**
Not yet. Fluux's encryption engine is built as a plugin layer so OMEMO can be added alongside OpenPGP in the future, but at the moment the only supported protocol is XEP-0373.

## Reference

| Specification                                                                | Role                                                  |
|------------------------------------------------------------------------------|-------------------------------------------------------|
| [XEP-0373](https://xmpp.org/extensions/xep-0373.html) OpenPGP for XMPP       | Encrypted message format, key publication, backup    |
| [XEP-0380](https://xmpp.org/extensions/xep-0380.html) Explicit Encryption    | Hints to clients that a stanza is encrypted          |
| [XEP-0420](https://xmpp.org/extensions/xep-0420.html) Stanza Content         | Authenticated envelope used inside the encrypted blob |
| [XEP-0163](https://xmpp.org/extensions/xep-0163.html) Personal Eventing      | Distributes your public key and encrypted backup     |
| [RFC 9580](https://www.rfc-editor.org/rfc/rfc9580) OpenPGP                   | The underlying cryptography (via Sequoia-PGP)        |
