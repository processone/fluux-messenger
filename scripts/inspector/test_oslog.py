"""Framed process-log reader invariants on local socket peers; NOT iPhone proof.

Record bytes follow the layout libimobiledevice (src/ostrace.c, tools/idevicesyslog.c)
and pymobiledevice3 (services/os_trace.py) read from com.apple.os_trace_relay: a
type byte and length around a 129-byte header, then the process path, image path,
message, subsystem and category, each ending in NUL. The peer stands in for the
relay; test_service.py drives the same reader through the actual worker.
"""
import json
import os
import plistlib
import socket
import struct
import tempfile
import threading
import time
import unittest

from reader import Budget
from oslog import HEADER, RECORD_MAX, STREAM_FLAGS, LogReader

PROOF = []
PRIVATE = "PRIVATE-CANARY"
CONTAINER = "5C3E9D8A-6F0B-4C2A-9E3B-2D7A1F4C8B60"
APP = b"/private/var/containers/Bundle/Application/" + CONTAINER.encode() + b"/Fluux.app/Fluux"
WEBKIT = b"/System/Library/Frameworks/WebKit.framework"
WEBCONTENT = WEBKIT + b"/XPCServices/com.apple.WebKit.WebContent.xpc/com.apple.WebKit.WebContent"
NETWORKING = WEBKIT + b"/XPCServices/com.apple.WebKit.Networking.xpc/com.apple.WebKit.Networking"
XPCPROXY = b"/usr/libexec/xpcproxy"
RUNNINGBOARD = b"/usr/libexec/runningboardd"
SPRINGBOARD = b"/System/Library/CoreServices/SpringBoard.app/SpringBoard"
WEBKIT_IMAGE = WEBKIT + b"/WebKit"
SECONDS, MICROS = 1795040128, 123456
# The full header as both references describe it, packed field by field so the
# reader's own skip-layout is not used to build its input.
LAYOUT = struct.Struct("<BIIIQ16sHQQQIBB6sQII16sHIIHHHHI")
OK = {"Status": "RequestSuccessful"}
FIELDS = {"elapsedMs", "timeUs", "pid", "level", "process", "subsystem", "category"}


def record(pid, path, *, message=PRIVATE.encode(), image=WEBKIT_IMAGE, subsystem=b"", category=b"",
           level=0x00, kind=2, procid=None, micros=MICROS, header_size=None, marker=2, trailing=b"",
           sizes=None, strings=None):
    """One record body; sizes or strings override the encoded regions for adverse cases."""
    parts = strings or [value + b"\0" if value else b"" for value in (path, image, message, subsystem, category)]
    parts = list(parts) + [b""] * (5 - len(parts))
    n = sizes or [len(part) for part in parts]
    header = LAYOUT.pack(marker, kind, LAYOUT.size if header_size is None else header_size, pid,
                         pid if procid is None else procid, b"\x11" * 16, n[0], 0, 0, SECONDS, micros,
                         0, level, bytes(6), 0x2F4C8B60D1, 0x1A2B, 0, b"\x22" * 16, n[1], n[2], 0x3C10,
                         n[3], 0, n[4], 0, 0)
    return header + b"".join(parts) + trailing


def frame(body, kind=2):
    return bytes([kind]) + struct.pack("<I" if kind == 2 else ">I", len(body)) + body


def reply_frame(value=OK):
    return frame(plistlib.dumps(value), kind=1)


class Relay:
    """Stands in for the relay: reads the one request, replies, sends frames, waits."""

    def __init__(self, sock, frames, reply, hold):
        self.sock, self.frames, self.reply, self.hold = sock, frames, reply, hold
        self.request = None
        self.closed_by_reader = False
        self.errors = []

    def read_exact(self, n):
        data = b""
        while len(data) < n:
            chunk = self.sock.recv(n - len(data))
            if not chunk:
                raise EOFError()
            data += chunk
        return data

    def run(self):
        self.sock.settimeout(5)
        try:
            size = struct.unpack(">I", self.read_exact(4))[0]
            self.request = plistlib.loads(self.read_exact(size))
            self.sock.sendall(self.reply)
            for data in self.frames:
                self.sock.sendall(data)
            if self.hold:
                while self.sock.recv(65536):
                    pass
                self.closed_by_reader = True
        except EOFError:
            self.closed_by_reader = True
        except OSError:
            pass
        except BaseException:
            self.errors.append("relay-invariant")
        finally:
            self.sock.close()


class StopAfter:
    """End a positive journey once a given number of records is persisted."""

    def __init__(self, file, stop, count):
        self.file, self.stop, self.count = file, stop, count

    def flush(self):
        self.file.flush()
        self.count -= 1
        if self.count <= 0:
            self.stop.set()

    def __getattr__(self, name):
        return getattr(self.file, name)


def exercise(frames, *, reply=None, duration=2, pid=None, budget=None, stop=None, stop_after=None,
             hold=True, output_mode=None, prefill=b"", wrap=None):
    client, server = socket.socketpair()
    relay = Relay(server, frames, reply_frame() if reply is None else reply, hold)
    thread = threading.Thread(target=relay.run)
    thread.start()
    stop = stop if stop is not None else threading.Event()
    budget = budget if budget is not None else Budget()
    with tempfile.TemporaryFile("w+b") as output:
        if output_mode is not None:
            os.fchmod(output.fileno(), output_mode)
        if prefill:
            output.write(prefill)
            output.flush()
            output.seek(0)
        target = StopAfter(output, stop, stop_after) if stop_after else output
        reader = LogReader(wrap(client) if wrap else client, budget)
        try:
            result = reader.run(target, stop=stop, duration=duration, pid=pid)
        finally:
            thread.join(5)
        output.seek(len(prefill))
        saved = output.read()
    assert not thread.is_alive(), "relay-not-closed"
    assert not relay.errors, relay.errors
    return result, saved, relay, reader, budget


class LogReaderProof(unittest.TestCase):
    def assert_private_absent(self, *artifacts):
        for artifact in artifacts:
            data = artifact if isinstance(artifact, bytes) else json.dumps(artifact).encode()
            for secret in (PRIVATE, CONTAINER, "runningboardd", "xpcproxy", "WebKit.framework"):
                self.assertNotIn(secret.encode(), data)

    def lines(self, saved):
        lines = [json.loads(line) for line in saved.splitlines()]
        for line in lines:
            self.assertEqual(set(line), FIELDS)
        return lines

    def test_listed_processes_keep_only_metadata(self):
        frames = [frame(body) for body in [
            record(33, RUNNINGBOARD, subsystem=b"com.apple.runningboard", category=b"process"),
            record(400, XPCPROXY),
            record(91, SPRINGBOARD, kind=0x0600),
            record(321, APP, subsystem=b"com.apple.WebKit", category=b"Process", level=0x10),
            record(321, APP, subsystem=b"net.processone.fluux", category=b"hinge", image=b""),
            # The same PID after xpcproxy executes WebKit's helper.
            record(400, WEBCONTENT, subsystem=b"com.apple.WebKit", category=PRIVATE.encode(), level=0x11),
            record(401, NETWORKING, subsystem=PRIVATE.encode(), category=PRIVATE.encode(), level=0x01),
            record(321, APP, message=b"", trailing=b"\0" * 8),
        ]]
        result, saved, relay, reader, budget = exercise(frames, stop_after=5)
        lines = self.lines(saved)
        PROOF.append({"scenario": "relay-framing", "request": relay.request, "result": result, "lines": lines})
        self.assertEqual(relay.request, {"Request": "StartActivity", "MessageFilter": 0xFFFF, "Pid": -1,
                                         "StreamFlags": STREAM_FLAGS})
        self.assertEqual(STREAM_FLAGS & 0x20, 0)
        self.assertTrue(relay.closed_by_reader)
        self.assertEqual((result["reason"], result["phase"]), ("stopped", "streaming"))
        self.assertEqual({k: result[k] for k in ("records", "emitted", "discarded", "unknownTypes", "trailingRecords")},
                         {"records": 8, "emitted": 5, "discarded": 2, "unknownTypes": 1, "trailingRecords": 1})
        self.assertEqual(result["pids"], {"fluux": [321], "webkit-content": [400], "webkit-networking": [401]})
        self.assertEqual([(l["pid"], l["process"], l["level"], l["subsystem"], l["category"]) for l in lines], [
            (321, "fluux", "error", "webkit", "Process"),
            (321, "fluux", "default", "fluux", "hinge"),
            (400, "webkit-content", "fault", "webkit", "other"),
            (401, "webkit-networking", "info", "other", "other"),
            (321, "fluux", "default", None, None),
        ])
        self.assertTrue(all(l["timeUs"] == SECONDS * 1_000_000 + MICROS for l in lines))
        self.assertTrue(all(type(l["elapsedMs"]) is float and l["elapsedMs"] >= 0 for l in lines))
        # Every byte read was charged, and every byte written was charged first.
        self.assertEqual(budget.input, result["receivedBytes"])
        self.assertEqual(budget.output, len(saved))
        self.assert_private_absent(saved, result)

    def test_pid_restricted_session(self):
        frames = [frame(record(321, APP)), frame(record(321, APP, subsystem=b"com.apple.WebKit", category=b"Loading"))]
        result, saved, relay, _, _ = exercise(frames, pid=321, stop_after=2)
        self.assertEqual(relay.request["Pid"], 321)
        self.assertEqual(result["reason"], "stopped")
        self.assertEqual([l["pid"] for l in self.lines(saved)], [321, 321])
        outside, outside_saved, _, _, _ = exercise([frame(record(321, APP)), frame(record(654, WEBCONTENT))], pid=321)
        self.assertEqual((outside["reason"], outside["phase"]), ("pid-boundary", "streaming"))
        self.assertEqual(outside["fault"]["site"], "_attribute")
        self.assertEqual(len(self.lines(outside_saved)), 1)
        with self.assertRaises(ValueError):
            LogReader(None, Budget()).run(None, pid=0)
        PROOF.append({"scenario": "pid-attribution", "case": "restricted", "request": relay.request,
                      "result": result, "outside": outside})
        self.assert_private_absent(saved, outside_saved, result, outside)

    def test_pid_attribution_fails_closed(self):
        # A listed PID that later names an unlisted process, then the listed one
        # again, must not keep its first attribution.
        unlisted = [frame(record(321, APP)), frame(record(321, RUNNINGBOARD)), frame(record(321, APP))]
        cases = {
            "procid-differs": ([frame(record(321, APP, procid=322))], 0, "parse_record", None),
            "zero-pid": ([frame(record(0, APP))], 0, "parse_record", None),
            "listed-label-changes": ([frame(record(321, APP)), frame(record(321, WEBCONTENT))], 1, "_attribute", None),
            "listed-to-unlisted": (unlisted, 1, "_attribute", None),
            "restricted-listed-to-unlisted": (unlisted, 1, "_attribute", 321),
        }
        for name, (frames, written, site, pid) in cases.items():
            with self.subTest(case=name):
                result, saved, relay, _, _ = exercise(frames, pid=pid)
                PROOF.append({"scenario": "pid-attribution", "case": name, "result": result})
                self.assertEqual((result["reason"], result["fault"]["site"]), ("pid-boundary", site))
                self.assertEqual(len(self.lines(saved)), written)
                self.assertTrue(relay.closed_by_reader)
                self.assert_private_absent(saved, result)

    def test_malformed_input_fails_closed(self):
        path = APP + b"\0"
        cases = {
            "refused": ([], reply_frame({"Status": "RequestFailed", "Error": PRIVATE}), "relay-refused", "start"),
            "reply-not-plist": ([], frame(PRIVATE.encode(), kind=1), "protocol-boundary", "start"),
            "reply-as-record": ([], frame(plistlib.dumps(OK)), "protocol-boundary", "start"),
            "reply-too-large": ([], b"\x01" + struct.pack(">I", 5000) + PRIVATE.encode(), "protocol-boundary", "start"),
            "unknown-frame": ([b"\x03" + struct.pack("<I", 4) + PRIVATE.encode()[:4]], None, "protocol-boundary", "streaming"),
            "reply-mid-stream": ([reply_frame()], None, "protocol-boundary", "streaming"),
            "short-record": ([frame(record(321, APP)[:100])], None, "record-boundary", "streaming"),
            "oversized-record": ([b"\x02" + struct.pack("<I", RECORD_MAX + 1)], None, "record-boundary", "streaming"),
            "header-size": ([frame(record(321, APP, header_size=0x80))], None, "record-boundary", "streaming"),
            "marker": ([frame(record(321, APP, marker=1))], None, "record-boundary", "streaming"),
            "overrun": ([frame(record(321, APP, sizes=[len(path), 0, 4096, 0, 0], strings=[path, b"", PRIVATE.encode() + b"\0"]))],
                        None, "record-boundary", "streaming"),
            "unterminated-path": ([frame(record(321, APP, strings=[APP + b"/", b"", PRIVATE.encode() + b"\0"]))],
                                  None, "record-boundary", "streaming"),
            "interior-nul-path": ([frame(record(321, APP, strings=[b"/a\0" + APP[3:] + b"\0", b"", b""]))],
                                  None, "record-boundary", "streaming"),
            "unterminated-message": ([frame(record(321, APP, strings=[path, b"", PRIVATE.encode() + b"!"]))],
                                     None, "record-boundary", "streaming"),
            "microseconds": ([frame(record(321, APP, micros=1_000_000))], None, "record-boundary", "streaming"),
        }
        for name, (frames, reply, reason, phase) in cases.items():
            with self.subTest(case=name):
                result, saved, relay, _, budget = exercise(frames, reply=reply)
                PROOF.append({"scenario": "fail-closed", "case": name, "result": result})
                self.assertEqual((result["reason"], result["phase"]), (reason, phase))
                self.assertEqual(saved, b"")
                self.assertTrue(relay.closed_by_reader)
                self.assert_private_absent(saved, result)
                if name == "oversized-record":
                    # Refused before its body was reserved: only the reply and prefix were charged.
                    self.assertEqual(budget.input, len(reply_frame()) + 5)

    def test_partial_frame_disconnect_and_unsafe_output(self):
        body = record(321, APP)
        partial, saved, relay, reader, budget = exercise([frame(body)[:20]], duration=.3)
        self.assertEqual((partial["reason"], partial["phase"]), ("time-limit", "streaming"))
        self.assertTrue(reader.read_desynchronized)
        # The declared body was reserved before any of it arrived, and stays charged.
        self.assertEqual(budget.input, len(reply_frame()) + 5 + len(body))
        self.assertLess(partial["receivedBytes"], budget.input)
        gone, _, _, _, _ = exercise([], hold=False)
        self.assertEqual((gone["reason"], gone["phase"]), ("disconnected", "streaming"))
        for name, options in {"shared-mode": {"output_mode": 0o644}, "not-empty": {"prefill": b"x"}}.items():
            with self.subTest(output=name):
                unsafe, _, peer, _, _ = exercise([], **options)
                self.assertEqual((unsafe["reason"], unsafe["phase"]), ("unsafe-output", "output"))
                self.assertIsNone(peer.request)
        PROOF.append({"scenario": "fail-closed", "case": "partial-disconnect-output", "partial": partial,
                      "disconnect": gone, "unsafeOutput": unsafe})
        self.assert_private_absent(saved, partial, gone)

    def test_shared_stop_deadline_and_cap(self):
        stop = threading.Event()
        timer = threading.Timer(.2, stop.set)
        timer.start()
        stopped, _, _, reader, _ = exercise([], stop=stop, duration=5)
        timer.join()
        self.assertEqual(stopped["reason"], "stopped")
        self.assertLess(stopped["elapsedSeconds"], .45)
        own = threading.Event()
        limited, _, _, _, _ = exercise([], stop=own, duration=.3)
        self.assertEqual(limited["reason"], "time-limit")
        self.assertTrue(own.is_set(), "the reader signals the other collectors when it ends")
        self.assertLess(limited["elapsedSeconds"], .55)
        early = threading.Event()
        early.set()
        before, _, relay, _, _ = exercise([], stop=early)
        self.assertEqual((before["reason"], before["phase"]), ("stopped", "start"))
        self.assertIsNone(relay.request)
        capped = threading.Event()
        threading.Timer(.1, capped.set).start()
        start = time.monotonic()
        _, _, _, long_reader, _ = exercise([], stop=capped, duration=500)
        self.assertLessEqual(long_reader.deadline - start, 120.01)
        PROOF.append({"scenario": "shared-accounting", "case": "stop-deadline-cap", "externalStop": stopped,
                      "deadline": limited, "stopBeforeStart": before,
                      "cappedSeconds": round(long_reader.deadline - start, 2)})

    def test_budget_bounds_a_flood(self):
        # Unlisted records still spend the shared budget and cannot outlive it.
        flood = [frame(record(33 + i % 5, RUNNINGBOARD)) for i in range(400)]
        budget = Budget(64 * 1024)
        result, saved, relay, _, _ = exercise(flood, budget=budget)
        self.assertEqual(result["reason"], "byte-limit")
        self.assertEqual(saved, b"")
        self.assertLessEqual(budget.input + budget.output, 64 * 1024)
        self.assertGreater(result["discarded"], 100)
        # Output is charged before it is written: when the line does not fit, nothing is.
        one = frame(record(321, APP))
        tight = Budget(len(reply_frame()) + len(one) + 20)
        refused, refused_saved, _, _, _ = exercise([one], budget=tight)
        self.assertEqual((refused["reason"], refused["emitted"], refused_saved), ("byte-limit", 0, b""))
        self.assertEqual(tight.output, 0)
        PROOF.append({"scenario": "shared-accounting", "case": "flood-and-output-charge", "flood": result,
                      "outputRefused": refused})
        self.assert_private_absent(saved, result, refused)

    def test_interrupt_closes_and_reraises(self):
        class Interrupting:
            def __init__(self, sock):
                self.sock, self.reads = sock, 0

            def recv(self, n):
                self.reads += 1
                if self.reads == 2:
                    raise KeyboardInterrupt()
                return self.sock.recv(n)

            def __getattr__(self, name):
                return getattr(self.sock, name)

        holder = {}
        def wrap(sock):
            holder["sock"] = Interrupting(sock)
            return holder["sock"]
        with self.assertRaises(KeyboardInterrupt):
            exercise([frame(record(321, APP))], wrap=wrap)
        self.assertEqual(holder["sock"].sock.fileno(), -1)


if __name__ == "__main__":
    outcome = unittest.main(exit=False, verbosity=2)
    print(json.dumps({"tests": outcome.result.testsRun, "success": outcome.result.wasSuccessful(), "cases": PROOF}))
    if not outcome.result.wasSuccessful():
        raise SystemExit(1)
