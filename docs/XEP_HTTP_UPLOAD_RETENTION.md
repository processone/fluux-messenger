# HTTP Upload Retention Hint

Status: experimental ProcessOne extension, version 0.1. This is an implementation
specification, not an assigned or approved XSF XEP.

## Purpose and scope

This extension adds optional retention negotiation to [HTTP File Upload
(XEP-0363)](https://xmpp.org/extensions/xep-0363.html). A client suggests a duration;
the upload service decides its policy and reports the duration it actually
applies. The hint is generic: any upload may use it. One use is a file shared in a
private room message (a whisper), for which Fluux suggests 24 hours (86400 seconds).

An ephemeral message and an ephemeral uploaded file have separate lifetimes.
The XEP-0334 `no-store` message hint does not delete an HTTP upload. Recipients
can download and keep files. This extension reduces retention at the upload
service; it cannot guarantee erasure of recipient copies, caches, or backups.

XEP-0363 also defines `urn:xmpp:http:upload:purpose:0#ephemeral`, with an absolute
`expire-before` upper bound. This extension negotiates a relative duration and
reports the service's applied policy, which may exceed the suggestion. It does
not advertise or imply support for the standard ephemeral-purpose feature. If
both are implemented and requested, the applied duration MUST respect the
standard `expire-before` bound; a service unable to do so MUST reject that request.

## Namespace and discovery

Namespace and service-discovery feature:

```text
urn:processone:http-upload:retention:0
```

The entity granting upload slots MUST advertise this feature in its own
XEP-0030 disco#info response, alongside `urn:xmpp:http:upload:0`. Advertising it
on a parent domain does not establish support on a separate upload component.

```xml
<iq type='result' from='upload.example.test' to='alice@example.test/lab' id='disco1'>
  <query xmlns='http://jabber.org/protocol/disco#info'>
    <identity category='store' type='file' name='HTTP Upload'/>
    <feature var='urn:xmpp:http:upload:0'/>
    <feature var='urn:processone:http-upload:retention:0'/>
  </query>
</iq>
```

## Request

A client MAY add exactly one `retention` child in the extension namespace to
an XEP-0363 `request`. Its `suggested` attribute is a duration in seconds.
Durations MUST be positive base-10 integers in the range 1 to 9007199254740991
(the JavaScript safe-integer range). Fractions, signs, whitespace, zero, and
scientific notation are invalid. There are no additional required IQ exchanges.

```xml
<iq type='get' from='alice@example.test/lab' to='upload.example.test' id='slot1'>
  <request xmlns='urn:xmpp:http:upload:0'
           filename='notes.pdf' size='1024' content-type='application/pdf'>
    <retention xmlns='urn:processone:http-upload:retention:0' suggested='86400'/>
  </request>
</iq>
```

The client MUST treat `suggested` as a preference, never an assurance of deletion.
No hint means the service's existing default policy. Fluux's normal uploads do
not request a hint unless the caller explicitly opts in. The SDK permits hints
without advertisement for compatibility with services that ignore extension
children; the UI MUST still treat retention as unknown without advertisement.

## Slot response

For a valid hinted request, an advertising service MUST return exactly one
`retention` child in the extension namespace inside the granted `slot`, with an
`applied` attribute using the same integer format and range. The duration starts
when the successful HTTP PUT completes, not when the slot is granted. A service
MAY also report applied retention for unhinted requests.

```xml
<iq type='result' from='upload.example.test' to='alice@example.test/lab' id='slot1'>
  <slot xmlns='urn:xmpp:http:upload:0'>
    <put url='https://upload.example.test/put/opaque/notes.pdf'/>
    <get url='https://upload.example.test/get/opaque/notes.pdf'/>
    <retention xmlns='urn:processone:http-upload:retention:0' applied='3600'/>
  </slot>
</iq>
```

Here the server clamps the client's 24-hour suggestion to one hour. The client
shows one hour, not 24 hours. A missing or invalid `applied` value does not
invalidate otherwise valid slot URLs; it means unknown retention. Clients MUST
NOT fall back to the suggested duration when reporting the applied duration.
Each separately uploaded thumbnail receives its own hint and slot response. If
all durations are known, Fluux shows the longest duration for the complete
attachment. If any duration is unknown, it shows the retention warning.

## Server rules

- Admin policy remains authoritative. Services MAY clamp suggestions to configured
  minimum/maximum bounds or substitute their default duration. They MUST return
  the duration actually applied, even when it exceeds the suggestion.
- On an advertising service, malformed or duplicate retention elements MUST
  produce the usual IQ `bad-request` error. Services that cannot commit to a
  finite applied duration MUST NOT advertise this extension.
- The service MUST record the applied duration with the slot, establish expiry
  after successful PUT, and make the file unavailable through its GET endpoint
  no later than expiry. Physical storage cleanup MAY run later, provided expired
  files cannot be retrieved. Quotas or other policy MAY remove files earlier.
- PUT authorization, slot expiry, file size limits, content type, authentication,
  access rules, and XEP-0363 errors retain their existing meaning. Abandoned slots
  do not create retained files; failed/partial PUT cleanup follows server policy.
- The service MUST apply equivalent policy to any replicas or CDN URLs it controls.
  It SHOULD avoid cache lifetimes extending beyond expiry. Retention metadata
  MUST survive a restart or use a policy that does not extend promised availability.
- The server MUST NOT infer a whisper, recipient, or room from this generic hint.

## Compatibility and Fluux behavior

Legacy services may ignore the extension child and return an ordinary slot:

```xml
<slot xmlns='urn:xmpp:http:upload:0'>
  <put url='https://upload.example.test/put/opaque/notes.pdf'/>
  <get url='https://upload.example.test/get/opaque/notes.pdf'/>
</slot>
```

Fluux accepts that slot and uploads normally. Before uploading a whisper
attachment, it asks for confirmation that files remain on the upload server
according to its policy and recipients can keep copies. After upload, an
advertising service's valid applied duration is shown; otherwise the warning is
shown. Advertisement alone is insufficient to claim a duration. Upload rejection
remains an upload failure; clients MUST NOT send a whisper with a missing file.

The whisper is then addressed to `room/nick` with `type='chat'`, the ordinary
XEP-0066 OOB URL, URL body fallback (XEP-0428), file metadata (XEP-0446), and the
existing XEP-0334 `no-store` hint. It remains locally stored by Fluux and does not
become a public room message. The recipient sees the ordinary attachment UI.
Retention data is service policy metadata, not a new message persistence field.

## Implementation checklist for ejabberd

1. Advertise the feature on the `mod_http_upload` slot-granting JID when enabled.
2. Decode the namespaced request child, validate its integer, and apply configured bounds.
3. Encode `retention applied='…'` inside the slot response.
4. Carry the negotiated duration through PUT authorization and successful completion.
5. Persist the expiry and enforce it at GET, with eventual disk cleanup.
6. Test unclamped/clamped durations, absent hints, malformed/duplicate hints, restart,
   unsuccessful PUT, expiry, thumbnails, and clients ignoring response extensions.

The client SDK regression fixtures cover advertisement, hints, clamped response
values, unknown/malformed durations, and attachment whisper serialization/parsing.
Task-local loopback compatibility checks against unmodified ejabberd and Prosody
exercise legacy services; those checks do not prove extension support or deletion
on either server. A fixture response tests the advertised extension path until
the server implementation is available.
