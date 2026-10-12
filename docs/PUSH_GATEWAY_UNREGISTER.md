# Push gateway device unregistration

**Status:** Client contract; gateway implementation required for deletion.
**Transport:** XEP-0050 commands over the authenticated account's existing XMPP session.
**Gateways:** `pushgate.process-one.net` (production), `pushgatedev.process-one.net` (development).

Fluux registers APNs devices with `register-push-apns`, sending `device-id` and
`token` in a submitted data form. When push is switched off, on logout, account switch, or local account-data
clearing, it first sends XEP-0357 `<disable>` for its registered node to the user's
XMPP server, then requests deletion from the same gateway used for registration.
The installation keeps its `device-id`; subsequent login registers afresh.

## Command discovery and request

The client queries disco#items with node `http://jabber.org/protocol/commands` at
the gateway JID. It prefers an advertised `unregister-push-apns`, then an advertised
`unregister-push`. If neither is advertised or discovery fails, it uses
`unregister-push`. The gateway team should implement and advertise this contract.

```xml
<iq type="set" to="pushgate.process-one.net" id="unregister-1">
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
<iq type="result" from="pushgate.process-one.net" id="unregister-1">
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
