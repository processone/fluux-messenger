# Restricted inspector reader (FLM-351)

This is **preparation tooling, not a live-capture launcher**. The reader owns the
Web Inspector framing/routing/filter boundary for FLM-350. The separate FLM-366
service opener supplies its exclusive byte stream, only when explicitly called
with an already-authorized exact USB device identity. Neither component changes
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
Positive peer checks use the reader API's production cleanup budget; explicit
frozen/time-limit checks also exercise shortened budgets. Proof records complete
outbound frames accepted by the socket separately from peer-received selectors.
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
   supplied and proved on disposable peers, **not qualified on a real phone**.
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
code-location sanitizer, the native-log allowlist, process ownership evidence,
combined watchdog and budget integration, device service opener qualification,
and the final consent/capture workflow.

Protocol shapes were checked against pymobiledevice3's `services/webinspector.py`
and `services/web_protocol/inspector_session.py`. This module intentionally uses
standard-library socket/plist/JSON operations instead of those default sessions.
The sampler is the disposable FLM-350 sampler, preserved without changing its
measurement contract. No earlier audit conclusion was contradicted.

## Existing-pairing-only service opener (FLM-366)

`service_worker.c` owns usbmuxd, lockdown and in-memory TLS.
`service.py` owns the private control channel, shared budget reservations,
per-operation watchdog and process reaping. `Reader` remains the sole owner of
inspector framing/routing/filtering. No default inspector/session API is used.

Build without discovering or opening a phone:

```sh
bash scripts/inspector/build-service.sh /absolute/private/temp/service-worker
```

After **separate live attachment/device consent and qualification in FLM-350**,
the integration shape is:

```python
from service import open_service
from reader import Reader

# Existing whole-attempt Budget, private empty output and original host deadline
# come from FLM-350's coordinator. Never create a second allowance for this opener.
with open_service(worker_path, fresh_authorized_usb_identity, shared_budget,
                  lifetime=remaining_seconds_including_cleanup) as service:
    result = Reader(service, shared_budget).run(
        private_output, stop=shared_stop, duration=remaining_capture_seconds)
```

This is an API example, not a runnable live launcher or consent grant. Never print,
tee, log or persist the raw stream. `open_service` does not request pages or send
inspector commands; unavoidable service bytes enter only the existing reader.
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
only `StartService(com.apple.webinspector)` is sent, with no escrow bag. The service
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
- One control request/returned chunk is at most 64 KiB. Operations use the caller's
  positive timeout, at most one second; the deadline bounds the whole exchange,
  not each fragment. A completed no-data read raises `socket.timeout`; nonblocking
  OpenSSL retains partial TLS records safely. An incomplete local exchange aborts
  the worker with a fixed error rather than retrying possibly consumed/sent bytes.
- The worker's independent wall timer ends idle or orphaned work, even if the
  Python caller stops reading. Lifetime is at most 121 seconds (default 120.5),
  including startup/cleanup; FLM-350 supplies its original remaining deadline.
  `close` closes the private channel, gives graceful teardown 100 ms, then kills
  and reaps a stalled worker. Host kernel/process scheduling is not a real-time
  guarantee; an unresponsive kernel is outside this boundary.

### What disposable proof does and does not establish

The proof exchanges identical arbitrary bytes through authenticated TLS and an
explicit plaintext service, fragments encrypted records and inspector frames,
and runs the unchanged reader using actual fresh disposable WebKit measurements.
It exercises rejection of absent/malformed pairing, invalid keys, mismatched
certificates, denied sessions/services, duplicate/missing/network-only devices
and oversized metadata lengths. It exercises startup/no-data/write deadlines,
idle lifetime expiry, an unresponsive worker, budget exhaustion/concurrent charges,
fixed errors, silent success/failure and hostile inherited logging variables.
All workers, peer threads, sockets, fixture files and browsers are closed/removed.

These are live **host** executions against a disposable usbmuxd/lockdown/inspector
peer, not an Apple daemon or an iPhone. Real-device pairing-record/service shapes,
the installed device's certificate choice, iOS compatibility, Fluux inspectability
and remote frozen-page cleanup remain FLM-350's separate qualification. A different
pin or protocol shape fails closed; do not weaken the boundary or add a pairing
fallback to make a live connection work. No earlier audit finding was contradicted.
