# Push gateway device unregistration

**Status:** Client contract; gateway implementation required for deletion.
**Transport:** XEP-0050 commands over the authenticated account's existing XMPP session.
**Gateways:** `push.fluux.io` (production), `pushdev.fluux.io` (development).

Fluux registers APNs devices with `register-push-apns`, sending `device-id` and
`token` in a submitted data form. When push is switched off, on logout, account switch, or local account-data
clearing, it first sends XEP-0357 `<disable>` for its registered node to the user's
XMPP server, then requests deletion from the same gateway used for registration.
The installation keeps its `device-id`; subsequent login registers afresh.

## Gateway migration

On a fresh session, saved registrations for `pushgate.process-one.net` or
`pushgatedev.process-one.net` are retired only after registering with the new gateway
for the current APNs environment and successfully enabling the new node. The client disables the old XEP-0357 node,
then requests deletion from the old gateway using the saved installation ID and
token. Disable, discovery and command execution share a 1.5-second budget;
errors and timeouts are non-fatal. The saved registration is replaced only after
the new node is enabled; a failed registration or enable leaves old delivery active
for a retry on the next session.
The old production gateway remains available during the transition.

Retiring the old node preserves the replacement's push status. If the old node's
disable fails or cleanup times out, the client retains its original gateway,
installation ID, token and account owner in memory for later cleanup while the
same push registrar exists. Best-effort gateway unregistration alone is not proof that the
old node was disabled. Opt-out and session cleanup address both nodes within
the cleanup budget; retained legacy credentials remain actionable even after
opt-out removes the replacement registration. Network cleanup is restricted to
the owning account. See the migration and cancellation fixtures in
`apps/fluux/src/hooks/useNativePush.lifecycle.test.tsx`.

## Command discovery and request

The client queries disco#items with node `http://jabber.org/protocol/commands` at
the gateway JID. It prefers an advertised `unregister-push-apns`, then an advertised
`unregister-push`. If neither is advertised or discovery fails, it uses
`unregister-push`. The gateway team should implement and advertise this contract.

```xml
<iq type="set" to="push.fluux.io" id="unregister-1">
  <command xmlns="http://jabber.org/protocol/commands"
           node="unregister-push" action="execute">
    <x xmlns="jabber:x:data" type="submit">
      <field var="device-id"><value>installation-uuid</value></field>
      <field var="token"><value>last-registered-apns-token</value></field>
    </x>
  </command>
</iq>
```

`device-id` is required and is the same value sent at registration. `token` is
included when the client retains it. The authenticated stanza sender identifies
the account; a caller must only be allowed to remove its own registration for
that installation. The command must remove the gateway's token/account/device
mapping and its push-node registration. A supplied token must match the stored
registration; an old token must not delete a newer replacement.

## Responses and idempotency

Successful deletion, an unknown registration, and a repeated request all return
success. No multi-step form or session continuation is needed:

```xml
<iq type="result" from="push.fluux.io" id="unregister-1">
  <command xmlns="http://jabber.org/protocol/commands"
           node="unregister-push" status="completed"/>
</iq>
```

Unsupported deployments may return standard stanza errors such as
`item-not-found`, `feature-not-implemented`, or `service-unavailable`. Authorization
failures should return `forbidden`; malformed input should return `bad-request`.
The client treats errors, incomplete command responses and timeouts as non-fatal,
with diagnostics at debug level that omit tokens and secrets.

Disable, command discovery and command execution share a 1.5-second logout
budget. Offline clients skip network cleanup. The client always clears its local
registration and completes logout. A timed-out discovery cannot send a later
unregistration through a replacement account's session.

Gateway deletion requires gateway implementation and a successful online
round-trip. Otherwise the gateway's existing one-year inactivity expiry remains
the server-side cleanup fallback; XEP-0357 disable alone stops publication from
the user's server without deleting gateway data. Fixture tests prove client
behavior, not deployment of the gateway command.

For notification recipient ownership and signed-out presentation, see
[iOS remote push notifications](IOS_DEVELOPMENT.md#notification-recipient-ownership).
