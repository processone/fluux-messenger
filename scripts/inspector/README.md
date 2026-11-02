# Restricted inspector reader (FLM-351)

This is **preparation tooling, not a live-capture launcher**. It owns the Web
Inspector framing/routing/filter boundary for FLM-350. It neither discovers a
phone nor opens a device service, changes inspection settings, launches an app,
uses an account, reloads/restarts a page, or reads storage. Product code is unchanged.

## Disposable proof

With normal project dependencies and Playwright WebKit installed:

```sh
node scripts/inspector/prove.mjs
node --test scripts/inspector/ci-scope.test.mjs
```

CI runs the WebKit/socket proof in its own workflow, only for pull requests or
main-branch pushes that change `scripts/inspector/**`. It is not a browser-invariant
shard step. The fast scope contract exercises the actual workflow filters against
current project filenames; it does not execute GitHub's event engine.

The command closes a real disposable WebKit browser after measuring visible,
hidden and missing message-list states, rejecting immediate duplicate pulls,
reporting an error category without its payload, and removing/reinstalling the
FLM-350 sampler. It then runs the actual Python reader on local sockets carrying
those measurements in WebKit inspector frames. The peer includes unrelated apps,
private title/URL/console/error fields, identity/page/session changes, malformed
responses, byte exhaustion and unresponsive connections. It prints only sanitized
proof. Python 3.10+ and Node satisfying the project's engine requirement are needed;
there is no Python package dependency. No device is discovered or accessed.

**Proof boundary:** the wire peer stands in for `webinspectord`. This proves the
host reader's framing, requests, filtering, accounting and bounded socket closure,
not Apple's real transport, an installed app's inspectability, frozen iPhone
cleanup, native rendering or a recurrence of the blank page. The separate browser
check proves sampler removal on disposable WebKit, not on a frozen phone.

## Integration contract for FLM-350

1. Obtain the accepted plan's separate fresh consents before any paired-device
   access, page attachment/instrumentation, account navigation or optional setting
   change. Preparation approval and passing disposable proof grant none of these.
2. Open an **exclusive, blocking, byte-stream socket** for the already-authorized
   Web Inspector service. Give `Reader(socket, shared_budget)` sole ownership.
   The attachment consent must disclose that service-level discovery announces
   other applications' identities transiently in memory, though their page listings
   are never requested and that metadata is never retained.
   The service opener and its pairing/TLS/handshake diagnostics must themselves
   be audited and bounded before live use. Do not instantiate the default
   `pymobiledevice3.WebinspectorService` or `InspectorSession`: those already
   request other apps' listings or may format raw responses. No adapter to a
   real phone is supplied or qualified here.
3. Create one `Budget()` for the **whole attempt**, share it with the native-log
   collector, and charge that collector's raw input with `budget.charge(n)` before
   copying/decoding it. Charge its sanitized output with
   `budget.charge(n, output=True)` before writing it. Do not reset the budget or
   independently grant each reader five MiB. Inspector length prefixes, unknown
   frames and discarded metadata all count. A body length is reserved before
   allocation; abandoned partial bodies stay charged. `reservedInputBytes` can
   therefore exceed `receivedBytes`. The combined input-plus-output ceiling is
   deliberately stricter than separate input/output caps. Outbound inspector
   commands are not collected input or retained evidence.
4. Open an empty private binary regular file (mode 0600) outside the project and
   call `run(file, stop=shared_event, duration=remaining_seconds)`. Never pipe or
   tee raw service data. The file receives only reconstructed numeric/boolean/
   enum sample records, not remote mappings. `run()` returns local statistics;
   retain those separately only within the same budget. Close the output file.
   Keyboard interruption during collection records `reason: stopped`. An
   interruption during cleanup preserves the first reason collection ended.
   Both close the transport before re-raising `KeyboardInterrupt`; the same safe
   statistics remain in `reader.result`.
5. A host supervisor owns the attempt's original monotonic deadline (120 seconds
   maximum), twenty-second post-blank stop and all-reader stop event. It must set
   the shared event on user stop, disconnect or any reader's boundary failure.
   It must not wait for a page callback. The reader also sets that shared stop
   event on every exit, before its cleanup. Call this reader once only; no automatic
   reconnect or second attempt. A worker process can additionally contain a
   stalled local filesystem; normal deadline enforcement bounds socket I/O, not
   an unresponsive OS filesystem or untrusted caller code.
6. Inspect `reason` and `cleanup`. Cleanup uses a separate deadline of at most
   500ms. On an aligned stream it gives fixed sampler removal at most half of
   that time, reserving the rest for the page-socket close message even when the
   page never answers removal. It then shuts down and closes the transport.
   Inbound and outbound alignment are tracked separately. A partial inbound
   prefix/body forbids further reads, but aligned outbound removal and page-close
   messages are still sent. Without an acknowledgment, removal stays unconfirmed.
   A partial outbound frame forbids further framed writes, so cleanup goes
   straight to transport shutdown/close. An inbound cut never disables writes.
   It ignores the already-set stop event only for bounded cleanup. Input still
   spends the original budget; exhaustion can prevent a cleanup acknowledgment.
   `confirmed` requires the matching removal response to return true;
   `unconfirmed` is not success. Report it without restarting the app.
   `not-installed` means installation was never attempted, not that a remote page
   was inspected and found clean.

The reader selects only the exact `net.processone.fluux` bundle from unavoidable
service-level application metadata. Other app metadata is transient and never
written or used to request listings. It attaches only if that application exposes
one eligible web page; multiple Fluux processes/pages, changed identities/pages,
and cross-session messages stop closed. Page titles/URLs are not selection inputs.
The current protocol requires one `page` Target and uses Target-wrapped fixed
`Runtime.evaluate` commands. It checks for a pre-existing sampler before installation
and stops without removing it. No other inspector may mutate this page concurrently.
Destruction of the selected page target records only the fixed `target-destroyed`
reason. Provisional or unrelated target changes keep `target-boundary`; no private
event payload is retained. A destroyed target alone does not establish a crash or
explain the blank page. Unsupported protocol variants fail closed; do not add a
fallback that guesses a page or enables raw logging.

The inherited sampler reads geometry/visibility/counts through production hooks,
not row-attribute values or text. Both host and page limit sampling to four pulls
per second. Known invalid values stop capture; unknown fields are discarded before
serialization. Console and unexpected replies are never printed or persisted.
There is no stack capture: `stackFrames` must be empty. FLM-350 still owns a safe
code-location sanitizer, the native-log allowlist, process ownership evidence,
combined watchdog and budget integration, device service opener qualification,
and the final consent/capture workflow.

Protocol shapes were checked against pymobiledevice3's `services/webinspector.py`
and `services/web_protocol/inspector_session.py`. This module intentionally uses
standard-library socket/plist/JSON operations instead of those default sessions.
The sampler is the disposable FLM-350 sampler, preserved without changing its
measurement contract. No earlier audit conclusion was contradicted.
