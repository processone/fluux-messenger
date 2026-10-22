# Server archiving preferences

## Targeted audit (FLM-39)

The audit started on main `0c61c579`. Privacy settings already exposed the three
choices, and the SDK built and parsed preferences IQs with both exception lists.
However, the UI preferred a saved local override to the server response, updates
reused the lists from the initial render, and an empty success returned the
requested value without reading it back. Reconnecting could replay an old local
choice over a different server policy. Save responses had no account/session
boundary, and failures offered no read-only retry.

## Current contract

Preferences → Privacy displays the last server-confirmed account default:

| Choice | Protocol default |
| --- | --- |
| All exchanges | `always` |
| Contacts only | `roster` |
| No exchanges | `never` |

These choices set the account default. Contact exceptions can override it. Changing
the default does not delete existing archives and makes no promise about room
archives or archives held by other participants. This setting does not change MAM
pagination, catch-up, message caching, unread state or archive deletion.

The app reads preferences on entering the view and on reconnect, and provides a
read-only refresh. It shows loading, saving, offline, unsupported preferences,
access refusal, timeout, invalid response and other errors distinctly. MAM service
discovery is not proof that the server supports or permits preference changes.

Before changing the default, the app reads the current preferences again and
preserves both `always` and `never` lists. It locks the entire read/write operation,
and the SDK separately rejects concurrent preference writes until confirmation
finishes. The previous confirmed selection remains visible while saving. The
server's returned preferences, even when different from the request, govern the
selection. An empty success requires a fresh GET; an invalid response fails rather
than substituting the requested value. Each IQ has a ten-second response budget.

After a failure, the previous confirmation remains visible. Retry reads the server;
it never automatically resubmits a write whose outcome might be unknown. A timeout
or loss of connection after SET does not establish whether the server applied it.
The SDK rejects results from an old account or transport, including before the
empty-success readback. The UI independently invalidates outstanding work when its
owner/session changes or the view unmounts. A pre-save read from an obsolete view
cannot initiate a write.

## Protocol and concurrency limits

Preferences use `<prefs xmlns='urn:xmpp:mam:2'>` without a `to` address. This is the
preferences protocol originally in XEP-0313 §6, now specified separately in
[XEP-0441](https://xmpp.org/extensions/xep-0441.html). Both list elements are required
in responses, even when empty. Missing/duplicate lists or empty JID entries are
rejected instead of silently losing exceptions.

A SET replaces the complete preferences document. There is no revision number,
conditional write or transaction spanning GET and SET. Refreshing immediately
before writing reduces stale-list loss but cannot eliminate concurrent-client
races. Another client can change lists between GET and SET, or change the policy
after confirmation. The UI exposes this limitation and exception counts without
introducing an exception editor.

## Legacy local overrides

The server is the only authority. `effectiveArchiving` and the local-default
restore path are removed, as is the reconnect reapplication hook. Reading the
server again replaces the misleading “restore server default” action: a stored
`original` is not the server's current default.

The existing `fluux-archive-overrides` format and per-account values remain intact,
including the existing malformed-entry fallback. There is no destructive migration
and no new local choice written by this view. Legacy values neither affect the
selection nor initiate any server write. In particular, reconnecting after “No
exchanges” never silently enables archiving, and another client's change is not
undone. The compatibility test reloads a legacy stored document and checks that
valid account data remains readable without rewriting the stored document.

## Verification boundary

Regression tests exercise the SDK with preference IQ fixtures and the application
with controlled promises and server policy fixtures. `e2e/archiving-preferences.ts`
uses `demo.html` and the existing demo automation seams to exercise keyboard saves,
visible waiting, exceptions, retry, reconnect, mobile, large text and Arabic RTL in
Chromium and WebKit. These fixtures are explicitly not evidence from a real XMPP
server. No real account policy is changed by these checks.
