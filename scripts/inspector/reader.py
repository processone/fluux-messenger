"""FLM-349/351: restricted host-side Web Inspector reader; no device discovery.

The caller supplies an already-authorized, exclusive, blocking service socket.
Do not pass a WebinspectorService (it has already enumerated other apps' pages).
Only this module reads/writes the socket. No raw protocol object leaves it.
"""

import json
import math
import os
from pathlib import Path
import plistlib
import socket
import stat
import struct
import threading
import time
import uuid

CAP = 5 * 1024 * 1024
BUNDLE = "net.processone.fluux"
SAMPLER = Path(__file__).with_name("sampler.js").read_text()
PRESENT = "Object.hasOwn(window, '__flm350_measurements')"
SAMPLE = "window.__flm350_measurements.sample()"
REMOVE = "window.__flm350_measurements.stop()"
# FLM-349 allows no more than four pulls per second.
SAMPLE_INTERVAL = 1 / 4


class Boundary(Exception):
    """Only fixed categories, never remote values, may cross the API boundary."""


class Budget:
    """One conservative INPUT + OUTPUT cap, shared with other collector readers.

    Reserve a declared body before receiving/allocating it. Partial bodies remain
    charged. This deliberately overcounts abandoned frames rather than refunds
    bytes another producer could race to spend. No reset/retry in one attempt.
    """

    def __init__(self, limit=CAP):
        if type(limit) is not int or not 0 < limit <= CAP:
            raise ValueError("invalid-budget")
        self.limit = limit
        self.input = 0
        self.output = 0
        self.lock = threading.Lock()

    def charge(self, size, *, output=False):
        with self.lock:
            if type(size) is not int or size < 0 or self.input + self.output + size > self.limit:
                raise Boundary("byte-limit")
            if output:
                self.output += size
            else:
                self.input += size

    def exhausted(self):
        with self.lock:
            return self.input + self.output >= self.limit


def number(value, *, nullable=False, negative=False):
    if nullable and value is None:
        return None
    if type(value) not in (int, float) or not math.isfinite(value):
        raise Boundary("invalid-sample")
    if not (-1e9 if negative else 0) <= value <= 1e9:
        raise Boundary("invalid-sample")
    return value


def boolean(value):
    if type(value) is not bool:
        raise Boundary("invalid-sample")
    return value


def choice(value, choices):
    if type(value) is not str or value not in choices:
        raise Boundary("invalid-sample")
    return value


def sanitize_sample(value):
    """Rebuild a closed schema BEFORE serialization, never copy remote mappings.

    Unknown keys are discarded. Known fields with invalid values stop collection.
    Stack frames stay empty: arbitrary function names/URLs are not a sanitizer.
    """
    def box(v):
        if v is None:
            return None
        return {
            **{k: number(v[k], nullable=True, negative=k in ("x", "y", "scrollTop"))
               for k in ("x", "y", "width", "height", "opacity", "scrollTop", "scrollHeight", "clientHeight")},
            "display": choice(v["display"], ("none", "present")),
            "visibility": choice(v["visibility"], ("visible", "hidden", "collapse", "other")),
        }

    def count(v):
        if type(v) is not int or not 0 <= v <= 1_000_000:
            raise Boundary("invalid-sample")
        return v

    errors = value["errors"]
    if type(errors) is not list or len(errors) > 2:
        raise Boundary("invalid-sample")
    if value["stackFrames"] != []:
        raise Boundary("invalid-sample")
    return {
        "elapsedMs": number(value["elapsedMs"]),
        "gapMs": number(value["gapMs"], nullable=True),
        "visible": boolean(value["visible"]),
        "focused": boolean(value["focused"]),
        "viewport": {k: number(value["viewport"][k], nullable=True)
                     for k in ("width", "height", "visualWidth", "visualHeight")},
        "root": box(value["root"]), "list": box(value["list"]),
        "mountedRows": count(value["mountedRows"]),
        "intersectingRows": count(value["intersectingRows"]),
        "errors": [choice(e, ("window-error", "unhandled-rejection")) for e in errors],
        "stackFrames": [],
    }


class Reader:
    """Single-use reader. run() returns only local, enumerated stop statistics.

    The output must be a regular private file, opened by the caller. Duration is
    capped at 120 seconds; FLM-350 supplies its shared stop event for post-blank,
    disconnect, native-log boundary failures and user stop. Cleanup has a separate
    <=500ms deadline and never reloads, restarts or reconnects a page.
    """

    def __init__(self, service_socket, budget):
        self.sock = service_socket
        self.budget = budget
        self.connection = str(uuid.uuid4()).upper()
        self.sender = str(uuid.uuid4()).upper()
        self.app = None
        self.page = None
        self.target = None
        self.sequence = 0
        self.used = False
        self.attached = False
        self.install_attempted = False
        self.received = 0
        self.discarded = 0
        self.samples = 0
        self.read_desynchronized = False
        self.write_desynchronized = False
        self.result = None

    def _check(self):
        if time.monotonic() >= self.deadline:
            raise Boundary("time-limit")
        if self.stop.is_set() and not self.cleaning:
            raise Boundary("stopped")

    def _read(self, size):
        self.budget.charge(size)
        data = bytearray()
        try:
            while len(data) < size:
                self._check()
                self.sock.settimeout(min(.025, max(.001, self.deadline - time.monotonic())))
                try:
                    chunk = self.sock.recv(min(size - len(data), 65536))
                except socket.timeout:
                    continue
                if not chunk:
                    raise Boundary("disconnected")
                self.received += len(chunk)
                data.extend(chunk)
            return data
        finally:
            if 0 < len(data) < size:
                self.read_desynchronized = True

    def _recv(self):
        if self.read_desynchronized:
            raise Boundary("protocol-boundary")
        size = struct.unpack(">I", self._read(4))[0]
        if not size:
            raise Boundary("protocol-boundary")
        # A consumed prefix commits us to its body, even if no body byte arrives.
        # _read reserves size before allocating, including unknown/other-app data.
        try:
            payload = self._read(size)
        except BaseException:
            self.read_desynchronized = True
            raise
        value = plistlib.loads(payload)
        if type(value) is not dict or type(value.get("__argument")) is not dict:
            raise Boundary("protocol-boundary")
        return value["__selector"], value["__argument"]

    def _send(self, selector, args=None):
        if self.write_desynchronized:
            raise Boundary("protocol-boundary")
        self._check()
        args = dict(args or {}, WIRConnectionIdentifierKey=self.connection)
        body = plistlib.dumps({"__selector": selector, "__argument": args})
        packet = memoryview(struct.pack(">I", len(body)) + body)
        pending = packet
        try:
            while pending:
                self._check()
                self.sock.settimeout(min(.025, max(.001, self.deadline - time.monotonic())))
                try:
                    sent = self.sock.send(pending)
                except socket.timeout:
                    continue
                if not sent:
                    raise Boundary("disconnected")
                pending = pending[sent:]
        finally:
            if 0 < len(pending) < len(packet):
                self.write_desynchronized = True

    def _page_args(self):
        return {"WIRApplicationIdentifierKey": self.app, "WIRPageIdentifierKey": self.page,
                "WIRSenderKey": self.sender}

    def _command(self, method, params):
        self.sequence += 1
        message = {"id": self.sequence, "method": method, "params": params}
        if self.target is not None:
            message = {"id": self.sequence, "method": "Target.sendMessageToTarget", "params": {
                "targetId": self.target, "message": json.dumps(message)}}
        self._send("_rpc_forwardSocketData:", dict(self._page_args(),
                   WIRSessionIdentifierKey=self.sender, WIRSocketDataKey=json.dumps(message).encode()))
        return self.sequence

    def _event(self):
        selector, arg = self._recv()
        if selector in ("_rpc_reportConnectedApplicationList:", "_rpc_applicationConnected:",
                        "_rpc_applicationUpdated:"):
            apps = (arg["WIRApplicationDictionaryKey"].values()
                    if selector == "_rpc_reportConnectedApplicationList:" else [arg])
            matches = []
            for app in apps:
                if app.get("WIRApplicationBundleIdentifierKey") == BUNDLE:
                    identity = app["WIRApplicationIdentifierKey"]
                    if (type(identity) is not str or not identity.startswith("PID:")
                            or not 0 < len(identity[4:]) <= 10 or not identity[4:].isascii()
                            or not identity[4:].isdigit() or int(identity[4:]) <= 0):
                        raise Boundary("identity-boundary")
                    matches.append(identity)
                elif self.app is not None and app.get("WIRApplicationIdentifierKey") == self.app:
                    raise Boundary("identity-boundary")
            if (len(set(matches)) > 1 or (self.app and any(x != self.app for x in matches))
                    or (self.app and selector == "_rpc_reportConnectedApplicationList:" and self.app not in matches)):
                raise Boundary("identity-boundary")
            if self.app is None and matches:
                self.app = matches[0]
                self._send("_rpc_forwardGetListing:", {"WIRApplicationIdentifierKey": self.app})
            return None
        if selector == "_rpc_applicationDisconnected:" and arg.get("WIRApplicationIdentifierKey") == self.app:
            raise Boundary("disconnected")
        if selector == "_rpc_applicationSentListing:":
            if self.app is None or arg.get("WIRApplicationIdentifierKey") != self.app:
                self.discarded += 1
                return None
            pages = [p for p in arg["WIRListingKey"].values()
                     if p.get("WIRTypeKey") in ("WIRTypeWebPage", "WIRTypeWeb")]
            # Never use a URL/title to guess which account/page the user intended.
            if len(pages) != 1:
                raise Boundary("page-boundary")
            page = pages[0]["WIRPageIdentifierKey"]
            if type(page) is not int or page <= 0 or (self.page and page != self.page):
                raise Boundary("page-boundary")
            if self.page is None:
                self.page = page
                self.attached = True  # A failed setup send may still have reached the peer.
                self._send("_rpc_forwardSocketSetup:", dict(self._page_args(),
                           WIRMessageDataTypeChunkSupportedKey=0, WIRAutomaticallyPause=False))
            return None
        if selector != "_rpc_applicationSentData:":
            self.discarded += 1
            return None
        if (self.page is None or arg.get("WIRApplicationIdentifierKey") != self.app
                or arg.get("WIRDestinationKey") != self.sender):
            raise Boundary("session-boundary")
        message = json.loads(arg["WIRMessageDataKey"])
        method = message.get("method")
        if method == "Target.targetCreated":
            info = message["params"]["targetInfo"]
            target = info["targetId"]
            if info.get("type") != "page" or type(target) is not str or len(target) > 128:
                raise Boundary("target-boundary")
            if self.target is not None and target != self.target:
                raise Boundary("target-boundary")
            self.target = target
            return None
        if method == "Target.targetDestroyed":
            if self.target is None or message["params"].get("targetId") != self.target:
                raise Boundary("target-boundary")
            raise Boundary("target-destroyed")
        if method == "Target.didCommitProvisionalTarget":
            raise Boundary("target-boundary")
        if method == "Target.dispatchMessageFromTarget":
            if self.target is None or message["params"]["targetId"] != self.target:
                raise Boundary("target-boundary")
            message = json.loads(message["params"]["message"])
        return message

    def _evaluate(self, expression):
        request = self._command("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "generatePreview": False,
            "includeCommandLineAPI": False, "doNotPauseOnExceptionsAndMuteConsole": True,
        })
        while True:
            message = self._event()
            if message is None:
                continue
            if message.get("id") != request:
                self.discarded += 1
                continue
            # Target wrapper acknowledgments contain an empty result, not a value.
            result = message.get("result", {})
            if result == {} and "error" not in message:
                continue
            if "error" in message or result.get("wasThrown") or "exceptionDetails" in result:
                raise Boundary("evaluation-failed")
            remote = result["result"]
            return remote.get("value")

    def run(self, output, *, stop=None, duration=120, cleanup_timeout=.5):
        if self.used:
            raise ValueError("single-use-reader")
        self.used = True
        self.stop = stop if stop is not None else threading.Event()
        self.cleaning = False
        self.deadline = time.monotonic() + min(120, max(0, duration))
        reason = "protocol-boundary"
        cleanup = "not-installed"
        interrupted = None
        started = time.monotonic()
        try:
            mode = os.fstat(output.fileno())
            if (not stat.S_ISREG(mode.st_mode) or mode.st_mode & 0o077
                    or mode.st_size != 0 or output.tell() != 0):
                raise Boundary("unsafe-output")
            self._send("_rpc_reportIdentifier:")
            self._send("_rpc_getConnectedApplications:")
            while self.page is None or self.target is None:
                self._event()
            if self._evaluate(PRESENT) is not False:
                raise Boundary("sampler-already-present")
            self.install_attempted = True
            if self._evaluate(SAMPLER) is not True:
                raise Boundary("evaluation-failed")
            next_sample = 0
            while True:
                self._check()
                if self.budget.exhausted():
                    raise Boundary("byte-limit")
                now = time.monotonic()
                if now < next_sample:
                    self.stop.wait(min(.025, next_sample - now))
                    continue
                value = self._evaluate(SAMPLE)
                # Start the next interval after the response, not before a send
                # that scheduler/transport delays could move to the interval's end.
                next_sample = time.monotonic() + SAMPLE_INTERVAL
                if value is None:
                    continue
                self._check()
                record = sanitize_sample(value)
                encoded = (json.dumps(record, allow_nan=False, separators=(",", ":")) + "\n").encode()
                self._check()
                self.budget.charge(len(encoded), output=True)
                output.write(encoded)
                output.flush()
                self.samples += 1
        except Boundary as error:
            reason = error.args[0]
        except KeyboardInterrupt as error:
            reason, interrupted = "stopped", error
        except Exception:
            # No exception repr, logger, traceback, protocol payload or free text.
            reason = "protocol-boundary"
        finally:
            # Signal other collector readers immediately, before bounded cleanup.
            self.stop.set()
            self.cleaning = True
            cleanup_start = time.monotonic()
            cleanup_budget = min(.5, max(0, cleanup_timeout))
            cleanup_end = cleanup_start + cleanup_budget
            try:
                if self.install_attempted:
                    cleanup = "unconfirmed"
                    if not self.write_desynchronized:
                        # A frozen removal cannot consume the close message's slice.
                        self.deadline = cleanup_start + cleanup_budget / 2
                        try:
                            if self._evaluate(REMOVE) is True:
                                cleanup = "confirmed"
                        except KeyboardInterrupt as error:
                            interrupted = error
                        except Exception:
                            pass
                # An inbound cut prevents acknowledgments, not aligned writes.
                # Removal itself may have cut the outbound frame: recheck it.
                if self.attached and not self.write_desynchronized:
                    self.deadline = cleanup_end
                    try:
                        self._send("_rpc_forwardDidClose:", self._page_args())
                    except KeyboardInterrupt as error:
                        interrupted = error
                    except Exception:
                        pass
            finally:
                try:
                    self.sock.shutdown(socket.SHUT_RDWR)
                except KeyboardInterrupt as error:
                    interrupted = error
                except OSError:
                    pass
                finally:
                    try:
                        self.sock.close()
                    except KeyboardInterrupt as error:
                        interrupted = error
                    finally:
                        self.app = self.page = self.target = None
        self.result = {"reason": reason, "cleanup": cleanup, "samples": self.samples,
                       "discarded": self.discarded, "receivedBytes": self.received,
                       "reservedInputBytes": self.budget.input, "outputBytes": self.budget.output,
                       "elapsedSeconds": round(time.monotonic() - started, 4)}
        if interrupted is not None:
            raise interrupted
        return self.result
