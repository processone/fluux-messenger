# Restricted inspector reader (FLM-351)

This is **preparation tooling, not a live-capture launcher**. The reader owns the
Web Inspector framing/routing/filter boundary for FLM-350. The separate FLM-366
service opener supplies its exclusive byte stream, only when explicitly called
with an already-authorized exact USB device identity. `oslog.py` reads the
iPhone's framed process-log relay through the same opener and keeps only fixed
metadata from listed processes (see Framed process logs). None of these changes
inspection settings, launches an app, uses an account, reloads/restarts a page,
or reads storage. Product application code is unchanged.

## Disposable proof

With normal project dependencies, Playwright WebKit, Python 3.10+, a C11 compiler,
`pkg-config`, OpenSSL 3+ development files and libplist 2.3+ development files:
On macOS the native prerequisites are available through Homebrew's `openssl@3`
and `libplist`; on Debian/Ubuntu use `libssl-dev`, `libplist-dev` and `pkg-config`.

```sh
node scripts/inspector/prove.mjs
node --test scripts/inspector/ci-scope.test.mjs
```

The shared changed-scope classifier selects the inspector job only when its file
list names `scripts/inspector/` changes. `ci.yml` skips that job with `if:` otherwise
and reuses the shared Playwright and apt caches. There is no separate path-filtered
workflow or browser-invariant shard step. Runs without a changed-file list do not
select this timing probe through broad JS/Rust fallbacks. The fast scope contract
executes the actual classifier; it does not execute GitHub's job scheduler.

The command builds the service worker in a temporary directory and removes it on
exit. `FLUUX_INSPECTOR_TEMP` optionally chooses the parent of that directory.
It creates fresh disposable pairing certificates and a private Unix-socket peer,
then exercises the **actual worker and OpenSSL**, not a mocked native library.
No real phone, system pairing record, account, keychain or signing material is
accessed. Short-lived sockets use private, randomly named `/tmp/flm366-*.sock`
paths because macOS limits Unix socket path lengths; they are closed/unlinked.
Generated peer keys stay in the disposable fixture directory and are removed.
Production worker code never writes or loads a key file.

The command also closes a real disposable WebKit browser after measuring visible,
hidden and missing message-list states, reporting an error category without its
payload, and removing/reinstalling the FLM-350 sampler. A separate page in that
browser checks the sampler's 250 ms spacing on a clock paused before the page
opens: pulls 0 ms and 249 ms after an accepted sample return nothing, and a pull
250 ms after it returns a sample with a 250 ms gap, however slowly a loaded
machine answers. The command then runs the actual Python reader on local sockets
carrying only the real-clock measurements in WebKit inspector frames. The peer
includes unrelated apps, private title/URL/console/error fields, identity/page/session
changes, malformed responses, byte exhaustion and unresponsive connections. It
prints only sanitized proof. Python 3.10+ and Node satisfying the project's engine
requirement are needed; there is no Python package dependency. No device is
discovered or accessed.

**Proof boundary:** the wire peer stands in for `webinspectord`. This proves the
host reader's framing, requests, filtering, accounting and bounded socket closure,
not Apple's real transport, an installed app's inspectability, frozen iPhone
cleanup, native rendering or a recurrence of the blank page. The separate browser
check proves sampler removal on disposable WebKit, not on a frozen phone.
Positive peer checks use the reader API's production cleanup budget. Pre-install
silent/partial/no-Fluux cases exercise short real collection deadlines. Frozen
cleanup and cleanup-interrupt fixtures instead expire collection at the first
sample request, which proves installation was acknowledged; a separate outer
setup guard still fails missing progress. Immediate and 200 ms application-list
replies exercise the same post-install cleanup path. The cap assertion measures
removal-to-close separately from startup and keeps the existing cleanup cap.
This phase control is a fixture stand-in, not a change to the reader's production
startup deadline. Proof records complete outbound frames accepted by the socket
separately from peer-received selectors.
A failed peer response writer can miss a queued close frame; a sent frame alone
is not evidence that the peer processed it.

## Integration contract for FLM-350

1. Obtain the accepted plan's separate fresh consents before any paired-device
   access, page attachment/instrumentation, account navigation or optional setting
   change. Preparation approval and passing disposable proof grant none of these.
2. Open an **exclusive, blocking, socket-compatible byte stream** for the already-authorized
   Web Inspector service. Give `Reader(socket, shared_budget)` sole ownership.
   The attachment consent must disclose that service-level discovery announces
   other applications' identities transiently in memory, though their page listings
   are never requested and that metadata is never retained.
   The service opener and its pairing/TLS/handshake diagnostics must themselves
   be audited and bounded before live use. Do not instantiate the default
   `pymobiledevice3.WebinspectorService` or `InspectorSession`: those already
   request other apps' listings or may format raw responses. The opener below is
   proved on disposable peers. In FLM-377 it opened the captain's iPhone (iOS
   27.0.1), and the reader attached to Fluux's page, took four content-free
   samples and confirmed their removal.
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
   Through the opener, a reply the host scheduled late can still finish up to
   500 ms after either deadline (see Bounds and accounting), so cleanup can last
   up to about 1.1 seconds. A removal reply that ends after the cleanup deadline
   leaves no time for the close message, which is then skipped. A worker that
   stops answering holds cleanup about 0.65 s when it stops at removal, and up to
   about 0.9 s when it stops at the close message, before the opener kills and
   reaps it.
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
7. `phase` and `fault` locate a stop without retaining what caused it. `phase`
   is the furthest step reached: `output`, `applications`, `listing`, `target`,
   `presence`, `install` or `sampling`. `fault` names the exception class from a
   fixed list (else `other`), the reader function and line where it was raised,
   an allowlisted protocol field name for a missing-key fault, and the opener's
   fixed category for a transport fault (for example `service-closed`). It
   never carries exception text or remote values. `reason` keeps its existing
   categories, so a transport fault still reports `protocol-boundary`.

The reader selects only the exact `net.processone.fluux` bundle from unavoidable
service-level application metadata. Other app metadata is transient and never
written or used to request listings. It attaches only if that application exposes
one eligible web page; multiple Fluux processes/pages, changed identities/pages,
and cross-session messages stop closed. Page titles/URLs are not selection inputs.
The current protocol requires one `page` Target and uses Target-wrapped fixed
`Runtime.evaluate` commands. It checks for a pre-existing sampler before installation
and stops without removing it. No other inspector may mutate this page concurrently.
Destruction of the selected page target records only the fixed `target-destroyed`
reason. No selected target or a missing target identity cannot produce that reason.
Provisional or unrelated target changes keep `target-boundary`; no private
event payload is retained. A destroyed target alone does not establish a crash or
explain the blank page. Unsupported protocol variants fail closed; do not add a
fallback that guesses a page or enables raw logging.

The inherited sampler reads geometry/visibility/counts through production hooks,
not row-attribute values or text. Both host and page limit sampling to four pulls
per second. Known invalid values stop capture; unknown fields are discarded before
serialization. Console and unexpected replies are never printed or persisted.
There is no stack capture: `stackFrames` must be empty. FLM-350 still owns a safe
code-location sanitizer, the supervisor that runs both readers under one watchdog,
device service opener qualification for a full capture, and the final
consent/capture workflow. The framed process-log reader below supplies the
native-log allowlist, PID ownership evidence and the shared budget and stop event.

Protocol shapes were checked against pymobiledevice3's `services/webinspector.py`
and `services/web_protocol/inspector_session.py`. This module intentionally uses
standard-library socket/plist/JSON operations instead of those default sessions.
The sampler is the disposable FLM-350 sampler, preserved without changing its
measurement contract. No earlier audit conclusion was contradicted.

## Structural observer for real-device diagnosis (FLM-377)

`structure.StructureTap(stream, shared_budget)` wraps the opened service and is
handed to `Reader` in its place. The reader stays the only protocol actor; the
tap forwards every call unchanged and never sends, retries or reconnects. It
reassembles complete frames in each direction and keeps at most 128 structural
entries: the selector, each argument key with its value's type, application and
listing counts, whether the Fluux bundle and its hosted WebKit processes are
present, Target and Runtime method names, and the type of each JSON field.
Keys and names outside fixed patterns are only counted. Payloads are released
as soon as they are described. Only Fluux's own listing is described;
other applications contribute counts and key presence, never identifiers.

The tap charges its retained entries to the attempt's shared budget as output.
A decode failure or budget refusal stops observation (`observerFault`,
`truncated`) but never changes the reader's outcome. `report()` returns the
entries plus counts of omitted messages and the sizes of any partial frame.
Call `assert_sanitized(report)` before writing it. It checks form, as a second
line of defense: keys must be schema words, fixed labels, `WIR…` key names or a
single camelCase word; strings must be schema words, fixed labels, `_rpc_…:`
selectors or `Domain.method` names; numbers must be integers or booleans. Any
short lowercase word passes as a key and any `Word.word` string as a method
name, so the tap's own rules keep values out: it writes only protocol key
names, selectors, method names and type tags in those places.

Disposable proof runs every reader scenario with and without the tap and checks
that reason, phase, fault, cleanup, samples and persisted output are identical,
and that no titles, routes, text or console content reach the report.

What the real iPhone sent (iOS 27.0.1, four FLM-377 sessions): `_rpc_reportCurrentState:`
(an automation-availability string), the application list, and an empty
`_rpc_reportConnectedDriverList:`. Each application entry carried its bundle
identifier, a PNG icon of about 4 KB, its identifier, name, automation
availability, `WIRIsApplicationActiveKey` as an integer, and proxy and ready
flags as booleans. Other apps then arrived through `_rpc_applicationConnected:`
and `_rpc_applicationUpdated:`, each with an unrequested
`_rpc_applicationSentListing:`, and the list could repeat. The reader accepted all
of it; the `iphone` peer mode in `test_reader.py` reproduces that order and shape.
Fluux was listed only in the fourth session. The captain reported another app on
screen in the first two and did not think Fluux was running in the third. Its Tauri build enables the `devtools` feature on every
target, which makes the web view inspectable on iOS too. Fluux's entry had the
same keys, with `WIRIsApplicationActiveKey` 2 and not ready until its page was
set up, then an `_rpc_applicationUpdated:` marked it ready. Its one
`WIRTypeWebPage` listing carried a host application identifier, an override name,
an integer page identifier, title, type and URL; during sampling Fluux listed the
same page again with a connection identifier added. The `iphone` peer mode
reproduces Fluux's part too.

The second FLM-377 session stopped with `protocol-boundary` from a transport fault,
not a message shape: the reader's fault named `ServiceError`/`service-io` at its
read while it waited in the applications phase. FLM-350's earlier stop had the
same reason but kept no fault detail. `test_service.py` pauses a healthy worker for 150 ms
during an idle read and through a whole reader journey to keep that fixed. With
the larger reply margin, the third session stayed connected for its full 15
seconds with no fault.

## Existing-pairing-only service opener (FLM-366)

`service_worker.c` owns usbmuxd, lockdown and in-memory TLS.
`service.py` owns the private control channel, shared budget reservations,
per-operation watchdog and process reaping. `Reader` remains the sole owner of
inspector framing/routing/filtering, and `oslog.LogReader` of process-log relay
framing. No default inspector/session API is used.

Build without discovering or opening a phone:

```sh
bash scripts/inspector/build-service.sh /absolute/private/temp/service-worker
```

After **separate live attachment/device consent and qualification in FLM-350**,
the integration shape is:

```python
import time

from service import CONTROL_GRACE, open_service
from reader import Reader

# Existing whole-attempt Budget, private empty output and original host deadline
# come from FLM-350's coordinator. Never create a second allowance for this opener.
# Lifetime covers the rest of the capture, the reader's 0.5 s cleanup and one
# reply margin: at most 121 s for the 120 s maximum capture.
with open_service(worker_path, fresh_authorized_usb_identity, shared_budget,
                  lifetime=capture_deadline - time.monotonic() + .5 + CONTROL_GRACE) as service:
    result = Reader(service, shared_budget).run(
        private_output, stop=shared_stop, duration=capture_deadline - time.monotonic())
```

This is an API example, not a runnable live launcher or consent grant. Never print,
tee, log or persist the raw stream. `open_service` does not request pages or send
inspector commands; unavoidable service bytes enter only the reader it was opened for.
The stream implements only `settimeout`, `recv`, `send`, `shutdown(SHUT_RDWR)` and
idempotent `close`, plus a context manager. It exposes no duplicate/socket-file
API, listener or public port. Concurrent operations are refused. It is single-use,
with no reconnect or fallback; the caller still excludes other inspectors.

### Trust and protocol boundary

The opener talks directly to the local `/var/run/usbmuxd` socket. The explicit
`mux_socket` override exists for private disposable peers, not network discovery.
It ignores environment-based daemon redirection. It requests one bounded
`ListDevices`, selects exactly one USB entry with the supplied identity, reads
only that entry's existing `ReadPairRecord`, and reads `ReadBUID`. Unrelated
identities remain transient; zero/duplicate matches and network-only entries fail.
There is no `Pair`, `ValidatePair`, record save/delete, key generation, escrow-bag
request or convenience handshake, including on failure.

The worker obtains the existing HostID/certificates/private key **in memory from
the pairing daemon**. Using those real credentials is sensitive and must be named
in FLM-350's consent. They are not sent to Python, command arguments, environment,
files or diagnostics. OpenSSL loads the existing root certificate/private key from
memory BIOs; the worker never uses a file-based key loader. Public certificates
participate in TLS as required; the private key does not leave the worker. This is
not a guarantee of erased allocator pages, protected process memory or protection
from a compromised local daemon/library/host. Core dumps are disabled before keys
are read, and the caller starts the worker with a minimal environment, discarded
stdout/stderr and no inherited credential/logging configuration.

Only `StartSession` with the existing HostID/SystemBUID is allowed. The session
must require TLS, using TLS 1.2 or newer and the **exact DeviceCertificate pin**
from that existing record. The root certificate/private key authenticate the host.
No public CA or hostname fallback substitutes for the pin. After pin verification,
exactly one `StartService` is sent, with no escrow bag, naming
`com.apple.webinspector` or `com.apple.os_trace_relay`. The caller chooses between
those two with a fixed numeric code and cannot send any other name. The service
uses TLS with the same pin if lockdown requires it, otherwise explicit plaintext
inside the authorized USB tunnel. A failed pin is closed without further lockdown
commands; a verified session gets best-effort `StopSession` on closure. This does
not confirm page/sampler removal; only the reader's acknowledgment can do that.

Protocol shapes follow the source of
[libusbmuxd](https://github.com/libimobiledevice/libusbmuxd/blob/2.1.1/src/libusbmuxd.c),
[lockdown](https://github.com/libimobiledevice/libimobiledevice/blob/1.4.0/src/lockdown.c)
and its [in-memory TLS implementation](https://github.com/libimobiledevice/libimobiledevice/blob/1.4.0/src/idevice.c).
The opener intentionally avoids the convenience handshake's pairing path and the
file-based certificate/private-key loading required by Python's default TLS API.

### Bounds and accounting

- Startup: at most five seconds, within the supplied remaining lifetime. Before
  any daemon I/O, reserve 256 KiB of **input** on the existing shared Budget.
- Every native read, including usbmuxd/lockdown framing, pair-record bytes and
  encrypted TLS read-ahead, subtracts from prepaid input credit **before reading**.
  Metadata messages and embedded pair records are limited to 64 KiB before parsing.
  Before an operation the adapter tops unused credit up to 64 KiB if needed;
  unused credit is never refunded, including failed startup/partial records.
- Reader-decoded input and sanitized output are still charged normally. Counting
  decrypted data again is deliberate conservative overcounting, not another
  independent five-MiB allowance. Existing charges remain intact; another reader
  cannot spend the opener's reserved credit. Native received bytes never exceed
  the paid amount, and total native input/output each have a separate five-MiB cap.
  Outbound commands are bounded but are not retained collected evidence.
- One control request/returned chunk is at most 64 KiB. Native service waits use
  the caller's positive timeout, at most one second. The local control exchange
  adds one fixed 500 ms reply margin, so the reader's final 1 ms poll can return
  no-data without destroying its cleanup channel, and a healthy worker that the
  host scheduled late still answers. On the Mac that runs the fleet, short timers
  in a background process ran up to about 150 ms late; the earlier 25 ms margin
  turned such a late reply into a closed stream on the real iPhone (FLM-377). The
  margin runs past whatever wait the reader set, so a late reply can end a capture
  poll or a cleanup step up to 500 ms after the reader's own deadline. A stopped
  worker is still detected once its wait and this margin pass, then killed and
  reaped: about 0.65 s for the reader's 25 ms polls. The whole exchange has one
  absolute deadline; fragments do not reset it. Native no-data polling has no
  1 ms minimum wait. A completed no-data read raises `socket.timeout` and keeps
  partial TLS records safely inside OpenSSL. Native writes wait for readiness
  within their service deadline and retry the same pending bytes, including
  OpenSSL's WANT_WRITE/WANT_READ, rather than closing at transient backpressure.
  An incomplete or interrupted local exchange still aborts the worker with a
  fixed error instead of replaying possibly consumed/sent bytes.
- The worker's independent wall timer ends idle or orphaned work, even if the
  Python caller stops reading, and ends the worker even mid-exchange. Lifetime is
  at most 121 seconds and covers startup, capture, cleanup and one reply margin:
  supply the time left to the capture deadline plus the reader's 500 ms cleanup
  plus `CONTROL_GRACE` (500 ms), which stays within 121 seconds for the
  120-second maximum capture. The default 120.5 therefore suits a capture of at
  most 119.5 seconds; FLM-350 supplies its own value from its original deadline.
  Sized as capture plus cleanup only, a late close reply outlives the worker: its
  timer ends it and the close message is lost. This sizing covers one late reply.
  If the final capture poll and a cleanup reply are both late, the lifetime can
  still cut removal or the close message, and a cut removal reports `unconfirmed`.
  `close` closes the private channel, gives graceful teardown 100 ms, then kills
  and reaps a stalled worker. The worker starts in a separate session/process
  group, so Ctrl-C sent to the caller's group does not kill it independently.
  As selected for W2, an interrupted half-finished exchange still fails closed;
  that path cannot promise sampler removal and reports unconfirmed cleanup.
  Host kernel/process scheduling is not a real-time guarantee; an unresponsive
  kernel is outside this boundary.

### What disposable proof does and does not establish

The proof exchanges identical arbitrary bytes through authenticated TLS and an
explicit plaintext service, fragments encrypted records and inspector frames,
and runs the unchanged reader using actual fresh disposable WebKit measurements.
It exercises rejection of absent/malformed pairing, invalid keys, mismatched
certificates, denied sessions/services, duplicate/missing/network-only devices
and oversized metadata lengths. It exercises startup/no-data/write deadlines,
idle lifetime expiry, an unresponsive worker, budget exhaustion/concurrent charges,
fixed errors, silent success/failure and hostile inherited logging variables.
The positive Reader-through-opener journey stops at a complete persisted sample,
not an arbitrary deadline that could legitimately cut an inbound sample frame.
Adverse journeys separately exercise a frozen sample/removal, a late sample reply
arriving during cleanup, a partial sample frame at the deadline, disconnect,
private inspector error and an in-exchange SIGINT. Deadline journeys preserve
`time-limit` and send both removal and page-close commands. A cut inbound sample
keeps cleanup unconfirmed; a complete late sample permits removal acknowledgment.
Disconnect retains the unchanged `protocol-boundary` category (W3); interrupted
partial exchanges retain selected
fail-closed/unconfirmed behavior (W2), not a removal guarantee. A separately owned
caller group receives SIGINT while its isolated worker survives and exchanges
bytes. TLS and plaintext backpressure peers prove complete byte-identical writes
that span a controlled peer read pause, as well as bounded permanent-stall closure.
All workers, peer threads, sockets, fixture files and browsers are closed/removed.

These are live **host** executions against a disposable usbmuxd/lockdown/inspector
peer, not an Apple daemon or an iPhone. FLM-377's live sessions exercised the
real pairing, certificate and announcement phase, and in the fourth session page
attachment, sampling and confirmed removal on Fluux's page; remote frozen-page
cleanup on a real phone remains unqualified. A different
pin or protocol shape fails closed; do not weaken the boundary or add a pairing
fallback to make a live connection work. No earlier audit finding was contradicted.

## Framed process logs

`oslog.LogReader(stream, shared_budget)` reads the iPhone's process-log relay,
`com.apple.os_trace_relay`, from a stream opened with
`open_service(worker, identity, shared_budget, service='os-trace-relay', lifetime=...)`.
It is the only reader or writer of that stream. It sends one request, never
discovers or opens a device itself, and has no retry or reconnect.

```python
with open_service(worker_path, fresh_authorized_usb_identity, shared_budget,
                  service='os-trace-relay',
                  lifetime=capture_deadline - time.monotonic() + CONTROL_GRACE) as logs:
    result = LogReader(logs, shared_budget).run(
        private_log_output, stop=shared_stop, duration=capture_deadline - time.monotonic())
```

### Protocol

Wire shapes follow libimobiledevice's
[`src/ostrace.c`](https://github.com/libimobiledevice/libimobiledevice/blob/1.4.0/src/ostrace.c)
and [`tools/idevicesyslog.c`](https://github.com/libimobiledevice/libimobiledevice/blob/1.4.0/tools/idevicesyslog.c),
and pymobiledevice3's `services/os_trace.py`.

1. The reader sends a big-endian length and a `StartActivity` property list with
   `MessageFilter` 0xFFFF, `Pid` -1 (all processes) or one PID, and `StreamFlags`
   0x1C: payload, historical and call stack. Both references also set the debug
   flag (0x3C); it is left out because it only adds volume to a shared budget.
2. The relay answers with a frame of type 1 and a big-endian length, holding a
   status dictionary of at most 4 KiB. Anything but `RequestSuccessful` stops
   with `relay-refused`; the status is compared, never copied.
3. Records follow as frames of type 2 with a little-endian length. A record is a
   129-byte header followed by five NUL-terminated regions: process path, image
   path, message, subsystem and category. Its size must lie between the header
   size and 16 KiB.

The header is unpacked only for its marker, record type, header size, PID,
process identifier, time, level and region sizes; the UUIDs, thread and activity
identifiers, mach time and image offset between them are skipped and never read.
Every region must end with its NUL inside the record. The process path, subsystem
and category must hold no other NUL. The image path and message are checked only
for their terminator and are never scanned, decoded or copied. A well-framed
record with an unknown type is counted in `unknownTypes` and dropped. Bytes after
the five regions are allowed and counted in `trailingRecords`, so a live run shows
whether the real layout has them.

### What is written

Each listed record becomes one JSON line with exactly `elapsedMs`, `timeUs`
(device time in microseconds), `pid`, `level`, `process`, `subsystem` and
`category`, rebuilt from code-owned values:

- `process`: `fluux` for an executable path ending in `/Fluux.app/Fluux`;
  `webkit-content`, `webkit-networking` or `webkit-gpu` for WebKit's helper
  processes under `/System/`, as XPC services or extensions. Records of every other
  process are checked, counted in `discarded` and dropped.
- `level`: `default`, `info`, `debug`, `error` or `fault`, else `other`.
- `subsystem`: `webkit` for `com.apple.WebKit`, `fluux` for `net.processone.fluux`,
  else `other`, or `null` when the record has none.
- `category`: WebKit's `ActivityState`, `Loading`, `MemoryPressure`, `Process`,
  `ProcessSuspension`, `ProcessSwapping` and `ViewState`; Fluux's `hinge` and
  `notification`; else `other`, or `null` when the record has none.

Messages, paths, image names, UUIDs and every other remote string stay out of
the output and the result.

### PID attribution

A record's PID must be positive and equal its header's process identifier, or the
capture stops with `pid-boundary`. One PID keeps one listed label for the whole
capture: a listed PID whose later record names another listed process, or an
unlisted one, stops with `pid-boundary`.
A PID first seen in an unlisted process and later in a listed one is accepted,
because `xpcproxy` starts WebKit's helpers by replacing itself in the same process.
At most 1024 listed PIDs are kept. `run(..., pid=n)` asks the relay for one
process, such as Fluux's from the inspector's `PID:n` application identifier, and
then requires every record to carry that PID. The result's `pids` maps each label
to the PIDs it held.

### Bounds and accounting

- One `Budget` is shared with the inspector reader and the opener. Every frame
  header and body is charged before it is read, and every output line before it
  is written. An exhausted budget stops with `byte-limit`.
- The deadline is at most 120 seconds. The reader shares the caller's stop event,
  sets it on every exit, then shuts down and closes the stream. Closing the
  connection ends the relay's stream; nothing is left to remove on the phone.
- A partial frame ends reading: the next read stops with `protocol-boundary`
  instead of resynchronizing on remote bytes.
- The output must be an empty private regular file (mode 0600), or the reader
  stops with `unsafe-output` before sending its request.
- `reason` is one of `time-limit`, `stopped`, `byte-limit`, `disconnected`,
  `unsafe-output`, `protocol-boundary`, `record-boundary`, `pid-boundary` or
  `relay-refused`. `phase` is `output`, `start` or `streaming`; `fault` has the
  inspector reader's fixed shape. The result also counts records, emitted and
  discarded lines, unknown types, trailing records, received and reserved input
  bytes and output bytes. Keyboard interruption records `stopped`, closes the
  stream and re-raises.

### Proof and its boundary

`test_oslog.py`, run by `prove.mjs`, drives the reader over a local socket peer
with realistic process paths and a private canary in every message, path and
image name. It checks that only listed processes and the seven fields above are
written, and that the canary reaches neither the output nor the result. It also
covers a PID-restricted session, PID attribution failures, malformed headers,
regions and frames, a partial frame, a disconnect, unsafe outputs, the shared stop
event, the deadline, the PID cap, a budget-exhausting flood and an interrupt.
`test_service.py` runs the reader through the actual worker and disposable
lockdown peer, checks that an unknown service code exits without contacting
usbmuxd, and runs the inspector reader and log reader on one budget and stop
event: a log flood exhausts the budget and stops the inspector, and the
inspector's deadline stops the logs.

The peer stands in for the iPhone's relay. The header layout and record types
follow the references above, not an observed device; a live run on the iPhone,
with its own consent, qualifies them.
