# Invitation Flow — Design

**Status:** design proposal (2026-06-09) · **Origin:** [STRATEGIC_REVIEW.md](STRATEGIC_REVIEW.md) §5
**Depends on:** admin console chantier (ROADMAP_2026 priority 1)

## Goal

> Admin generates a link → newcomer clicks → account provisioned → team rooms auto-joined →
> first conversation in 60 seconds.

Today a user without an XMPP account is stopped dead at the login screen
(`LoginScreen.tsx` has no registration or discovery path — UX_REVIEW §1.1, severity H).
This flow is the missing front door for both target segments: enterprise teams onboarding
staff, and communities solving cold start.

## Design principles

1. **ejabberd-first in capability, pure-XMPP in transport.** ejabberd exposes its full
   command set over XMPP ad-hoc commands (XEP-0050), not only REST. Fluux never talks to a
   REST API. Graceful degradation on other servers falls out of service discovery for free:
   if the server does not advertise the command/feature, the UI does not show it.
2. **Standards where they exist, ejabberd module where they don't.** The XEP suite for this
   flow already exists: XEP-0401 (Easy User Onboarding), XEP-0445 (Pre-Authenticated In-Band
   Registration), XEP-0379 (Pre-Authenticated Roster Subscription), XEP-0077 (In-Band
   Registration). ejabberd does not ship XEP-0401 token issuance today — that gap is filled
   server-side with an ejabberd module (first-class option for this project).
3. **The server provisions, the client just syncs.** Auto-join rooms and pre-populated
   contacts are written by the server into the new account (PEP native bookmarks XEP-0402,
   roster pushes) at redemption time. The client needs zero bootstrap-payload logic — it
   logs in and finds its world already set up.

## The flow

### 1. Generation (admin console, Fluux)

A new **Invitations** section in `AdminView`:

- "Generate invitation" → ad-hoc command on the server → returns `{token, xmpp_uri, landing_url, expires}`.
- Options on the form (XEP-0004 data form, so the server defines what it supports):
  - expiry (default 7 days), single-use (default) vs multi-use (community links)
  - pre-assigned username vs free choice at redemption
  - rooms to auto-bookmark (picker over the room list the admin can see)
  - roster pre-population (e.g. add the inviter, or a team group)
- List + revoke active invitations (ad-hoc command, RSM-paginated).

### 2. Distribution

- Copy link / copy QR code (mobile onboarding) straight from the generation result.
- The landing URL is shareable over any channel (email, existing chat, intranet).

### 3. Redemption

- **Landing page** (server-hosted static page, also linkable from anywhere):
  `https://<domain>/invite/#<token>` — token in the *fragment* so it never reaches server
  logs or referrers. Page offers "Open Fluux" (deep link) + download links + web-app link.
- **Deep link** (already supported by the Tauri app's `xmpp:` URI handling):
  `xmpp:<domain>?register;preauth=<token>` (XEP-0401 form). Web build: `/#/invite/<token>`
  route.
- Fluux opens a new **RegisterScreen**: username (free or pre-assigned, availability checked
  live), password, display name → submits XEP-0077 registration carrying the XEP-0445
  `<preauth/>` token → server validates the token, creates the account, **provisions
  bookmarks + roster**, burns the token (if single-use) → Fluux auto-logs-in → rooms appear
  joined, contacts present.

### 4. Degradation ladder (disco-driven)

| Server advertises | Experience |
|---|---|
| invite command + XEP-0445 | Full flow above |
| XEP-0077 only | "Create account" path without preauth (if registration is open) |
| neither | Login only; "create account" entry point hidden |

Peer-to-peer contact invites (any user inviting a friend, XEP-0379 preauth roster
subscription) are a natural **phase 2** — same URI scheme, no admin involvement.

## Work breakdown

### SDK (`packages/fluux-sdk`)

- `client.register(opts: {domain, username, password, preauthToken?})` — XEP-0077 + XEP-0445,
  pre-connection (stream without auth). New module; a good first consumer of the
  `registerModule` extension API ([SDK extensibility design](2026-06-09-sdk-extensibility-design.md)).
- Disco helpers: `server.supportsInviteGeneration()`, `server.supportsRegistration()`.
- Typed events: `register:success`, `register:error` (conflict, token-invalid, policy).

### App (`apps/fluux`)

- `RegisterScreen` + invite-URI/route handling (desktop deep link, web route).
- LoginScreen: secondary action "Don't have an account?" — shown only when disco (or an
  invite token) justifies it; otherwise links to a "what is XMPP" explainer.
- AdminView: Invitations section (generate / list / revoke).

### Server (ejabberd module)

- Token issuance/validation module exposing the ad-hoc commands above, hooking
  `mod_register` for redemption-time validation, and provisioning bookmarks/roster on
  success. Candidate for upstreaming once stable.

## Security notes

- Tokens: single-use by default, expiring, revocable, rate-limited at generation and
  redemption; stored hashed server-side.
- Token only ever travels in the URL fragment / XMPP stream, never in HTTP query strings.
- Multi-use community links should support an optional CAPTCHA hook server-side.
- Registration over the existing TLS/WSS channel only.

## Phasing

1. **Phase 1 — account invitations** (this doc): admin-generated, single-use, room/roster
   provisioning. The strategic unlock.
2. **Phase 2 — contact invites**: any user generates an XEP-0379 link from a contact's
   profile / own profile.
3. **Phase 3 — community links**: multi-use, room-scoped public invites with abuse controls.

## Open questions

- Landing page hosting: served by the ejabberd module (like Prosody's mod_invites pages) or
  a static asset deployed alongside? Module-served keeps the package self-contained.
- Should redemption auto-bookmark rooms as *autojoin* or just visible-in-list? (Proposal:
  autojoin for ≤3 rooms, visible otherwise.)
- Web-app URL for "Open in browser" on the landing page — requires a hosted web build per
  deployment; the module could template it from config.
