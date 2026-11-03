"""FLM-349/351 owns these invariants; local wire peers are NOT iPhone proof.

Samples arrive from actual disposable WebKit measurements in prove.mjs.
Wire shapes follow pymobiledevice3 services/webinspector.py; the peer simulates
webinspectord, including unwanted app metadata and asynchronous console events.
"""
import contextlib
import copy
import io
from inspect import signature
import json
import os
import plistlib
import signal
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest

from reader import BUNDLE, CAP, Budget, Boundary, Reader, PRESENT, SAMPLER, SAMPLE, REMOVE, SAMPLE_INTERVAL, sanitize_sample
from structure import StructureTap, assert_sanitized

SAMPLES = json.load(sys.stdin)
PROOF = []
PRIVATE = "PRIVATE-CANARY"
APP = {"WIRApplicationIdentifierKey": "PID:321", "WIRApplicationBundleIdentifierKey": BUNDLE,
       "WIRApplicationNameKey": PRIVATE}
OTHER = dict(APP, WIRApplicationIdentifierKey="PID:654", WIRApplicationBundleIdentifierKey="com.apple.mobilesafari")


def frame(selector, arg):
    body = plistlib.dumps({"__selector": selector, "__argument": arg}, fmt=plistlib.FMT_BINARY)
    return struct.pack(">I", len(body)) + body


def read_exact(sock, count):
    result = b""
    while len(result) < count:
        data = sock.recv(count - len(result))
        if not data:
            raise EOFError()
        result += data
    return result


class Peer:
    def __init__(self, sock, mode, stop, *, app_list_delay=0):
        self.sock, self.mode, self.stop = sock, mode, stop
        self.app_list_delay = app_list_delay
        self.requests, self.expressions, self.times = [], [], []
        self.errors = []
        self.closed = False
        self.sender = None
        self.released = threading.Event()
        self.target = "page-1"
        self.total_sent = 0
        self.sample_index = 0
        self.partial_started = False
        self.partial_cut_bytes = 0
        self.write_failed = False

    def send(self, selector, arg):
        if selector == "_rpc_reportConnectedApplicationList:" and self.app_list_delay:
            # FLM-366/368: an adverse input condition, not a stabilization wait.
            # Cleanup assertions must not assume this reply arrives within 150ms.
            self.stop.wait(self.app_list_delay)
        data = frame(selector, arg)
        if self.mode == "xml":
            body = plistlib.dumps({"__selector": selector, "__argument": arg})
            data = struct.pack(">I", len(body)) + body
        self.total_sent += len(data)
        try:
            self.sock.sendall(data)
        except (BrokenPipeError, ConnectionResetError):
            self.write_failed = True
            raise

    def data(self, message, **overrides):
        self.send("_rpc_applicationSentData:", dict({
            "WIRApplicationIdentifierKey": "PID:321", "WIRDestinationKey": self.sender,
            "WIRMessageDataKey": json.dumps(message)}, **overrides))

    def listing(self, app="PID:321", pages=1):
        self.send("_rpc_applicationSentListing:", {"WIRApplicationIdentifierKey": app,
                  "WIRListingKey": {str(i): {"WIRPageIdentifierKey": i, "WIRTypeKey": "WIRTypeWebPage",
                                            "WIRTitleKey": PRIVATE, "WIRURLKey": "https://example.invalid/" + PRIVATE}
                                    for i in range(1, pages + 1)}})

    def run(self):
        try:
            self.sock.settimeout(4)
            while True:
                n = struct.unpack(">I", read_exact(self.sock, 4))[0]
                msg = plistlib.loads(read_exact(self.sock, n))
                sel, arg = msg["__selector"], msg["__argument"]
                self.requests.append({"selector": sel, "app": arg.get("WIRApplicationIdentifierKey")})
                if self.mode == "silent":
                    continue
                if self.mode == "partial":
                    self.sock.sendall(struct.pack(">I", 2048) + b"bplist")
                    self.mode = "silent"
                    continue
                if self.mode == "oversize":
                    self.sock.sendall(struct.pack(">I", CAP + 1))
                    self.mode = "silent"
                    continue
                if sel == "_rpc_getConnectedApplications:":
                    # An unsolicited other-app listing must never cause attachment.
                    self.listing("PID:654")
                    apps = {"PID:654": OTHER, "PID:321": APP}
                    if self.mode == "duplicate-app":
                        apps["PID:999"] = dict(APP, WIRApplicationIdentifierKey="PID:999")
                    if self.mode == "no-fluux":
                        apps.pop("PID:321")
                    self.send("_rpc_reportConnectedApplicationList:", {"WIRApplicationDictionaryKey": apps})
                elif sel == "_rpc_forwardGetListing:":
                    assert arg["WIRApplicationIdentifierKey"] == "PID:321"
                    if self.mode == "missing-listing":
                        # FLM-377: a listing without its page map must name that field.
                        self.send("_rpc_applicationSentListing:", {"WIRApplicationIdentifierKey": "PID:321",
                                  "WIRTitleKey": PRIVATE})
                        continue
                    self.listing(pages=2 if self.mode == "multiple-pages" else 1)
                elif sel == "_rpc_forwardSocketSetup:":
                    self.sender = arg["WIRSenderKey"]
                    assert arg["WIRAutomaticallyPause"] is False
                    if self.mode == "destroyed-before-target":
                        self.data({"method": "Target.targetDestroyed", "params": {"private": PRIVATE}})
                        continue
                    self.data({"method": "Target.targetCreated", "params": {"targetInfo": {
                        "targetId": self.target, "type": "page", "title": PRIVATE, "url": PRIVATE}}})
                elif sel == "_rpc_forwardSocketData:":
                    command = json.loads(arg["WIRSocketDataKey"])
                    assert command["method"] == "Target.sendMessageToTarget"
                    assert command["params"]["targetId"] == self.target
                    inner = json.loads(command["params"]["message"])
                    assert inner["method"] == "Runtime.evaluate"
                    params = inner["params"]
                    assert params["returnByValue"] and not params["generatePreview"]
                    assert not params["includeCommandLineAPI"] and params["doNotPauseOnExceptionsAndMuteConsole"]
                    exp = params["expression"]
                    assert exp in (PRESENT, SAMPLER, SAMPLE, REMOVE)
                    self.expressions.append("sample" if exp == SAMPLE else "remove" if exp == REMOVE
                                            else "present" if exp == PRESENT else "install")
                    if self.partial_started:
                        continue
                    if exp == REMOVE and self.mode == "peer-write-failure":
                        # S4: fail the real response write while keeping the read half
                        # open but unobserved until the reader has closed its socket.
                        self.sock.shutdown(socket.SHUT_WR)
                        try:
                            self.data({"id": inner["id"], "result": {}})
                        except (BrokenPipeError, ConnectionResetError):
                            assert self.released.wait(4)
                            return
                        raise AssertionError("write-half shutdown did not fail")
                    if exp == REMOVE and self.mode in ("frozen", "interrupt-cleanup", "interrupt-target-cleanup"):
                        # Interrupt unanswered removal without racing a response writer's
                        # broken pipe against its observation of the close message.
                        continue
                    if ((exp == SAMPLE and self.mode in ("partial-prefix", "header-only", "partial-body"))
                            or (exp == REMOVE and self.mode == "partial-cleanup")):
                        response = frame("_rpc_applicationSentData:", {
                            "WIRApplicationIdentifierKey": "PID:321", "WIRDestinationKey": self.sender,
                            "WIRMessageDataKey": json.dumps({"id": inner["id"], "result": {
                                "result": {"value": True if exp == REMOVE else SAMPLES[0]}}})})
                        count = 2 if self.mode == "partial-prefix" else 4 if self.mode == "header-only" else 8
                        self.partial_cut_bytes = count
                        self.partial_started = True
                        self.sock.sendall(response[:count])
                        continue
                    if exp == SAMPLE:
                        self.times.append(time.monotonic())
                        if ((self.sample_index == 3 and self.mode in ("normal", "xml", "fragmented"))
                                or (self.sample_index == 1 and self.mode in ("one-sample", "partial-cleanup", "peer-write-failure"))):
                            self.stop.set()
                            continue
                        if self.mode == "disconnect":
                            break
                        if self.mode == "wrong-session":
                            self.data({"id": inner["id"], "result": PRIVATE}, WIRDestinationKey="other-session")
                            continue
                        if self.mode == "wrong-app":
                            self.data({"id": inner["id"]}, WIRApplicationIdentifierKey="PID:654")
                            continue
                        if self.mode == "identity-changed":
                            self.send("_rpc_applicationUpdated:", dict(OTHER, WIRApplicationIdentifierKey="PID:321"))
                            continue
                        if self.mode == "page-changed":
                            self.listing(pages=2)
                            continue
                        if self.mode in ("target-destroyed", "other-target-destroyed", "interrupt-target-cleanup"):
                            target = PRIVATE if self.mode == "other-target-destroyed" else self.target
                            self.data({"method": "Target.targetDestroyed", "params": {
                                "targetId": target, "private": PRIVATE}})
                            continue
                        if self.mode == "target-replaced":
                            self.data({"method": "Target.didCommitProvisionalTarget", "params": {
                                "oldTargetId": self.target, "newTargetId": PRIVATE}})
                            continue
                        if self.mode == "malformed":
                            self.send("_rpc_applicationSentData:", {"WIRApplicationIdentifierKey": "PID:321",
                                      "WIRDestinationKey": self.sender, "WIRMessageDataKey": PRIVATE})
                            continue
                        if self.mode == "eval-error":
                            self.data({"id": inner["id"], "error": {"message": PRIVATE, "data": PRIVATE}})
                            continue
                        value = copy.deepcopy(SAMPLES[self.sample_index % len(SAMPLES)])
                        value["private"] = PRIVATE
                        value["viewport"]["private"] = PRIVATE
                        if self.mode == "bad-sample":
                            value["mountedRows"] = PRIVATE
                        self.sample_index += 1
                    elif exp == PRESENT:
                        value = self.mode == "preexisting"
                    else:
                        value = True
                    # Unsolicited raw console/history and unknown replies cannot escape.
                    self.data({"method": "Console.messageAdded", "params": {"message": PRIVATE}})
                    self.data({"id": 9999, "error": {"message": PRIVATE}})
                    self.data({"id": command["id"], "result": {}})
                    self.data({"method": "Target.dispatchMessageFromTarget", "params": {
                        "targetId": self.target, "message": json.dumps({"id": inner["id"],
                        "result": {"result": {"type": "object" if exp == SAMPLE else "boolean", "value": value,
                                               "description": PRIVATE}}})}})
                    if self.mode == "blocked-send" and exp == PRESENT:
                        # After the presence check, read only the install frame's header.
                        # A tiny client send buffer stalls the actual fixed install command.
                        read_exact(self.sock, 4)
                        self.stop.set()
                        assert self.released.wait(4)
                        return
                elif sel == "_rpc_forwardDidClose:":
                    continue
        except (EOFError, BrokenPipeError, ConnectionResetError):
            self.closed = True
        except Exception as error:
            self.errors.append(type(error).__name__)
        finally:
            self.sock.close()
            self.closed = True


class ReaderTests(unittest.TestCase):
    # Positive lifecycle checks use the actual API budget, not a shorter fixture
    # deadline that can legitimately leave responsive XML cleanup unconfirmed.
    def exercise(self, mode, *, duration=.65, budget=None, app_list_delay=0,
                 expire_on_sample=False, tap=False,
                 cleanup=signature(Reader.run).parameters["cleanup_timeout"].default):
        client, server = socket.socketpair()
        if mode == "blocked-send":
            client.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1024)
        stop = threading.Event()
        peer = Peer(server, mode, stop, app_list_delay=app_list_delay)
        thread = threading.Thread(target=peer.run)
        thread.start()
        class ControlledSocket:
            cut = False
            writes_after_cut = 0
            interrupt_pending = False
            interrupt_delivered = False
            reads_after_inbound_cut = 0
            inbound_budget_at_cleanup = None
            partial_received = 0

            def __init__(self):
                self.request_times = []
                self.outbound = bytearray()
                self.sent_selectors = []
                self.expired_after_install = False
                self.cleanup_started = None
                self.closed_at = None

            def write(self, data):
                sent = client.send(data)
                self.outbound.extend(data[:sent])
                while len(self.outbound) >= 4:
                    size = struct.unpack(">I", self.outbound[:4])[0]
                    if len(self.outbound) < size + 4:
                        break
                    rpc = plistlib.loads(self.outbound[4:4 + size])
                    self.sent_selectors.append(rpc["__selector"])
                    del self.outbound[:4 + size]
                return sent

            def recv(self, count):
                if getattr(reader, "read_desynchronized", False):
                    self.reads_after_inbound_cut += 1
                if self.interrupt_pending:
                    self.interrupt_pending = False
                    self.interrupt_delivered = True
                    # Real SIGINT on the main thread, before consuming any bytes.
                    signal.raise_signal(signal.SIGINT)
                chunk = client.recv(min(count, 7) if mode == "fragmented" else count)
                if peer.partial_started and mode in ("partial-prefix", "header-only", "partial-body"):
                    self.partial_received += len(chunk)
                    if self.partial_received >= peer.partial_cut_bytes:
                        stop.set()
                return chunk

            def send(self, data):
                if self.cut:
                    sent = self.write(data)
                    self.writes_after_cut += sent
                    return sent
                try:
                    rpc = plistlib.loads(data[4:])
                    command = json.loads(rpc["__argument"]["WIRSocketDataKey"])
                    expression = json.loads(command["params"]["message"])["params"]["expression"]
                except (KeyError, ValueError, plistlib.InvalidFileException):
                    expression = None
                if expression == SAMPLE:
                    self.request_times.append(time.monotonic())
                if expression == REMOVE:
                    if self.cleanup_started is None:
                        self.cleanup_started = time.monotonic()
                    if getattr(reader, "read_desynchronized", False):
                        self.inbound_budget_at_cleanup = reader.budget.input
                if mode == "send-cutoff" and expression == SAMPLER:
                    sent = self.write(data[:8])
                    self.cut = True
                    stop.set()
                    return sent
                if (not self.interrupt_delivered
                        and ((mode == "interrupt-sample" and expression == SAMPLE)
                             or (mode in ("interrupt-cleanup", "interrupt-target-cleanup") and expression == REMOVE))):
                    self.interrupt_pending = True
                sent = self.write(data)
                if expire_on_sample and expression == SAMPLE:
                    # The first sample is requested only after installation's true
                    # acknowledgment. Expire collection here, not during discovery.
                    # duration is still an outer guard if setup never progresses.
                    self.expired_after_install = True
                    reader.deadline = time.monotonic()
                return sent

            def shutdown(self, how):
                if mode == "interrupt-shutdown":
                    signal.raise_signal(signal.SIGINT)
                return client.shutdown(how)

            def close(self):
                self.closed_at = time.monotonic()
                client.close()
                if mode == "interrupt-close":
                    signal.raise_signal(signal.SIGINT)

            def __getattr__(self, name):
                return getattr(client, name)

        controlled = ControlledSocket()
        budget = budget or Budget()
        observer = StructureTap(controlled, budget, **({"limit": tap} if type(tap) is int else {})) if tap else None
        reader = Reader(observer or controlled, budget)
        interrupt_propagated = False
        stdout, stderr = io.StringIO(), io.StringIO()
        try:
            with tempfile.TemporaryFile() as output, contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                if mode.startswith("interrupt-"):
                    with self.assertRaises(KeyboardInterrupt):
                        reader.run(output, duration=duration, stop=stop, cleanup_timeout=cleanup)
                    interrupt_propagated = True
                    result = reader.result
                    self.assertEqual(client.fileno(), -1)
                else:
                    result = reader.run(output, duration=duration, stop=stop, cleanup_timeout=cleanup)
                output.seek(0)
                persisted = output.read()
        finally:
            client.close()
            peer.released.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(peer.errors, [])
        self.assertTrue(peer.closed)
        self.assertTrue(stop.is_set())
        structure = observer.report() if observer else None
        self.assertNotIn(PRIVATE, persisted.decode() + stdout.getvalue() + stderr.getvalue() + json.dumps(result)
                         + json.dumps(structure))
        if observer:
            assert_sanitized(structure)
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
        self.assertLessEqual(result["reservedInputBytes"] + result["outputBytes"], reader.budget.limit)
        self.assertLessEqual(result["receivedBytes"], result["reservedInputBytes"])
        self.assertLess(result["elapsedSeconds"], duration + cleanup + .35)
        for request in peer.requests:
            if request["selector"] in ("_rpc_forwardGetListing:", "_rpc_forwardSocketSetup:"):
                self.assertEqual(request["app"], "PID:321")
        PROOF.append({"case": mode, "result": result, "retained": [json.loads(line) for line in persisted.splitlines()],
                      "selectors": [r["selector"] for r in peer.requests],
                      "outboundSelectors": controlled.sent_selectors,
                      "peerWriteFailed": peer.write_failed, "commands": peer.expressions,
                      "sampleIntervals": [round(b - a, 4) for a, b in zip(controlled.request_times, controlled.request_times[1:])],
                      "peerArrivalIntervals": [round(b - a, 4) for a, b in zip(peer.times, peer.times[1:])],
                      "peerClosed": peer.closed,
                      "readDesynchronized": getattr(reader, "read_desynchronized", False),
                      "writeDesynchronized": getattr(reader, "write_desynchronized", False),
                      "readsAfterInboundCut": controlled.reads_after_inbound_cut,
                      "inputReservedAtInboundCleanup": controlled.inbound_budget_at_cleanup,
                      "writesAfterCutoff": controlled.writes_after_cut,
                      "interruptPropagatedAfterClose": interrupt_propagated,
                      "applicationListDelaySeconds": app_list_delay,
                      "structure": structure,
                      "collectionExpiredAfterInstall": controlled.expired_after_install,
                      "cleanupElapsedSeconds": (round(controlled.closed_at - controlled.cleanup_started, 4)
                                                if controlled.cleanup_started is not None else None)})
        return result, peer, persisted

    def test_normal_filtered_sampling_and_detach(self):
        result, peer, persisted = self.exercise("normal", duration=2)
        self.assertEqual(result["reason"], "stopped")
        self.assertEqual((result["phase"], result["fault"]["class"], result["fault"]["site"]),
                         ("sampling", "Boundary", "_check"))
        self.assertEqual(result["cleanup"], "confirmed")
        self.assertEqual(result["samples"], 3)
        self.assertEqual(len(persisted.splitlines()), 3)
        self.assertTrue(all(value >= SAMPLE_INTERVAL for value in PROOF[-1]["sampleIntervals"]))
        self.assertEqual(peer.expressions[-1], "remove")
        self.assertIn("_rpc_forwardDidClose:", PROOF[-1]["outboundSelectors"])
        with self.assertRaises(ValueError):
            Reader(None, Budget(0))

    def test_xml_and_fragmented_transport(self):
        for mode in ("xml", "fragmented"):
            with self.subTest(mode=mode):
                result, _, persisted = self.exercise(mode, duration=2)
                self.assertEqual(result["reason"], "stopped")
                self.assertEqual(result["cleanup"], "confirmed")
                self.assertEqual(len(persisted.splitlines()), 3)

    def test_identity_and_routing_boundaries(self):
        # Captain-approved F4: only the selected target's destruction gets its signal.
        # FLM-377: the phase names how far discovery got before the boundary.
        for mode, reason, phase in [("duplicate-app", "identity-boundary", "applications"),
                                    ("multiple-pages", "page-boundary", "listing"),
                                    ("wrong-session", "session-boundary", "sampling"),
                                    ("wrong-app", "session-boundary", "sampling"),
                                    ("identity-changed", "identity-boundary", "sampling"),
                                    ("page-changed", "page-boundary", "sampling"),
                                    ("target-destroyed", "target-destroyed", "sampling"),
                                    ("other-target-destroyed", "target-boundary", "sampling"),
                                    ("destroyed-before-target", "target-boundary", "target"),
                                    ("target-replaced", "target-boundary", "sampling")]:
            with self.subTest(mode=mode):
                result, _, persisted = self.exercise(mode)
                self.assertEqual(result["reason"], reason)
                self.assertEqual((result["phase"], result["fault"]["class"], result["fault"]["site"]),
                                 (phase, "Boundary", "_event"))
                self.assertEqual(persisted, b"")

    def test_payloads_do_not_escape_error_paths(self):
        # FLM-377: FLM-350's live stop said only protocol-boundary. The fault names
        # the exception class, reader site and constant field, never a remote value.
        for mode, reason, phase, fault in [
                ("malformed", "protocol-boundary", "sampling", {"class": "JSONDecodeError", "site": "_event"}),
                ("missing-listing", "protocol-boundary", "listing",
                 {"class": "KeyError", "site": "_event", "field": "WIRListingKey"}),
                ("eval-error", "evaluation-failed", "sampling", {"class": "Boundary", "site": "_evaluate"}),
                ("bad-sample", "invalid-sample", "sampling", {"class": "Boundary", "site": "count"}),
                ("disconnect", "disconnected", "sampling", {"class": "Boundary", "site": "_read"})]:
            with self.subTest(mode=mode):
                result, _, persisted = self.exercise(mode)
                self.assertEqual(result["reason"], reason)
                self.assertEqual(result["phase"], phase)
                self.assertEqual({k: v for k, v in result["fault"].items() if k != "line"}, fault)
                self.assertEqual(type(result["fault"]["line"]), int)
                self.assertEqual(persisted, b"")

    def test_real_time_hung_partial_and_frozen_cleanup(self):
        for mode in ("silent", "partial", "no-fluux"):
            with self.subTest(mode=mode):
                result, peer, _ = self.exercise(mode, duration=.15, cleanup=.15,
                                               expire_on_sample=True)
                self.assertEqual(result["reason"], "time-limit")
                self.assertEqual(result["phase"], "applications")
                self.assertEqual(result["cleanup"], "not-installed")
                self.assertFalse(PROOF[-1]["collectionExpiredAfterInstall"])
        # FLM-366/368: frozen cleanup needs an installed sampler, not a fast
        # discovery reply. The same post-install deadline fires in both cases.
        for delay in (0, .2):
            with self.subTest(mode="frozen", app_list_delay=delay):
                result, peer, _ = self.exercise("frozen", duration=2, cleanup=.15,
                                               app_list_delay=delay, expire_on_sample=True)
                self.assertEqual(result["reason"], "time-limit")
                self.assertEqual(result["cleanup"], "unconfirmed")
                self.assertTrue(PROOF[-1]["collectionExpiredAfterInstall"])
                self.assertIn("install", peer.expressions)
                self.assertIn("remove", peer.expressions)
                # F1/S4: unanswered removal must leave time to write close.
                self.assertIn("_rpc_forwardDidClose:", PROOF[-1]["outboundSelectors"])

    def test_preexisting_sampler_is_not_removed(self):
        result, peer, persisted = self.exercise("preexisting")
        self.assertEqual(result["reason"], "sampler-already-present")
        self.assertEqual(result["phase"], "presence")
        self.assertEqual(result["cleanup"], "not-installed")
        self.assertEqual(peer.expressions, ["present"])
        self.assertEqual(persisted, b"")

    def test_cleanup_deadline_is_capped(self):
        # FLM-366/368: measure removal-to-close, excluding variable startup time.
        cap = signature(Reader.run).parameters["cleanup_timeout"].default
        for delay in (0, .2):
            with self.subTest(app_list_delay=delay):
                result, peer, _ = self.exercise("frozen", duration=2, cleanup=5,
                                               app_list_delay=delay, expire_on_sample=True)
                self.assertEqual(result["reason"], "time-limit")
                self.assertEqual(result["cleanup"], "unconfirmed")
                proof = PROOF[-1]
                self.assertTrue(proof["collectionExpiredAfterInstall"])
                self.assertIn("install", peer.expressions)
                self.assertIn("remove", peer.expressions)
                self.assertIn("_rpc_forwardDidClose:", proof["outboundSelectors"])
                self.assertLess(proof["cleanupElapsedSeconds"], cap + .35)

    def test_unsafe_output_rejected_before_discovery(self):
        for mode in ("public-file", "nonempty-file"):
            client, server = socket.socketpair()
            with tempfile.TemporaryFile() as output:
                if mode == "public-file":
                    os.fchmod(output.fileno(), 0o644)
                else:
                    output.write(b"existing")
                    output.flush()
                reader = Reader(client, Budget())
                result = reader.run(output, duration=.15)
                self.assertEqual(result["reason"], "unsafe-output")
                self.assertEqual((result["phase"], result["fault"]["site"]), ("output", "run"))
                self.assertEqual(server.recv(1), b"")
                self.assertEqual(result["receivedBytes"], 0)
                with self.assertRaises(ValueError):
                    reader.run(output)
            server.close()

    def test_stop_during_blocked_send(self):
        result, _, persisted = self.exercise("blocked-send", duration=2)
        self.assertEqual(result["reason"], "stopped")
        self.assertLess(result["elapsedSeconds"], .6)
        self.assertEqual(result["cleanup"], "unconfirmed")
        self.assertEqual(persisted, b"")

    def test_partial_frames_preserve_opposite_direction_cleanup(self):
        # Captain-approved R1: inbound damage must not suppress aligned writes.
        for mode in ("partial-prefix", "header-only", "partial-body", "partial-cleanup", "send-cutoff"):
            with self.subTest(mode=mode):
                result, peer, _ = self.exercise(mode, duration=2)
                self.assertEqual(result["reason"], "stopped")
                self.assertEqual(result["cleanup"], "unconfirmed")
                proof = PROOF[-1]
                self.assertEqual(proof["writesAfterCutoff"], 0)
                self.assertEqual(proof["readsAfterInboundCut"], 0)
                if mode == "send-cutoff":
                    self.assertTrue(proof["writeDesynchronized"])
                    self.assertFalse(proof["readDesynchronized"])
                    self.assertNotIn("remove", peer.expressions)
                    self.assertNotIn("_rpc_forwardDidClose:", proof["outboundSelectors"])
                else:
                    self.assertIn("remove", peer.expressions)
                    self.assertIn("_rpc_forwardDidClose:", proof["outboundSelectors"])
                    self.assertTrue(proof["readDesynchronized"])
                    self.assertFalse(proof["writeDesynchronized"])
                    if proof["inputReservedAtInboundCleanup"] is not None:
                        self.assertEqual(result["reservedInputBytes"], proof["inputReservedAtInboundCleanup"])

    def test_keyboard_interrupt_propagates_after_cleanup(self):
        # F5 plus captain-approved R2: cleanup SIGINT preserves the first reason.
        # FLM-366/368: these sibling cases also require installation before SIGINT.
        for delay in (0, .2):
            for mode in ("interrupt-sample", "interrupt-cleanup", "interrupt-shutdown", "interrupt-close", "interrupt-target-cleanup"):
                with self.subTest(mode=mode, app_list_delay=delay):
                    expire = mode in ("interrupt-cleanup", "interrupt-shutdown", "interrupt-close")
                    result, peer, _ = self.exercise(mode, duration=2, app_list_delay=delay,
                                                   expire_on_sample=expire)
                    expected = "stopped" if mode == "interrupt-sample" else "target-destroyed" if mode == "interrupt-target-cleanup" else "time-limit"
                    self.assertEqual(result["reason"], expected)
                    self.assertEqual(result["cleanup"], "unconfirmed" if mode in ("interrupt-cleanup", "interrupt-target-cleanup") else "confirmed")
                    self.assertIn("install", peer.expressions)
                    self.assertEqual(PROOF[-1]["collectionExpiredAfterInstall"], expire)
                    self.assertTrue(PROOF[-1]["interruptPropagatedAfterClose"])
                    self.assertIn("_rpc_forwardDidClose:", PROOF[-1]["outboundSelectors"])

    def test_close_write_evidence_survives_peer_response_failure(self):
        # S4: a queued complete write is not the same fact as peer observation.
        result, peer, _ = self.exercise("peer-write-failure", duration=2)
        self.assertEqual(result["reason"], "stopped")
        self.assertEqual(result["cleanup"], "unconfirmed")
        self.assertTrue(peer.write_failed)
        self.assertIn("_rpc_forwardDidClose:", PROOF[-1]["outboundSelectors"])
        self.assertNotIn("_rpc_forwardDidClose:", PROOF[-1]["selectors"])

    def test_oversized_header_never_reads_body(self):
        result, _, persisted = self.exercise("oversize")
        self.assertEqual(result["reason"], "byte-limit")
        self.assertEqual(result["receivedBytes"], 4)
        self.assertEqual(persisted, b"")

    def test_shared_budget_output_and_exact_limit(self):
        budget = Budget()
        budget.charge(CAP - 4)  # A second producer has already spent almost all input.
        result, _, persisted = self.exercise("oversize", budget=budget)
        self.assertEqual(result["reservedInputBytes"], CAP)
        self.assertEqual(result["receivedBytes"], 4)
        self.assertEqual(persisted, b"")
        budget = Budget(10)
        budget.charge(4)
        budget.charge(6, output=True)
        self.assertTrue(budget.exhausted())
        with self.assertRaises(Boundary):
            budget.charge(1, output=True)
        # Derive the exact first-record boundary from the actual wire and browser reading,
        # not a typed numeric pin. Replaying the same fixture preserves its byte lengths.
        class ObservedBudget(Budget):
            first_output_boundary = None

            def charge(self, size, *, output=False):
                if output and self.first_output_boundary is None:
                    self.first_output_boundary = self.input + self.output + size
                super().charge(size, output=output)

        observed = ObservedBudget()
        _, _, persisted = self.exercise("one-sample", duration=2, budget=observed)
        self.assertGreater(len(persisted), 0)
        boundary = observed.first_output_boundary
        insufficient = ObservedBudget(boundary - 1)
        limited, peer, retained = self.exercise("normal", duration=2, budget=insufficient)
        self.assertEqual(limited["reason"], "byte-limit")
        # Cleanup can spend remaining input bytes after the output rejection.
        # The observed first output charge proves it was the write that failed.
        self.assertEqual(insufficient.first_output_boundary, boundary)
        self.assertEqual(limited["outputBytes"], 0)
        self.assertEqual(peer.sample_index, 1)
        self.assertEqual(retained, b"")
        exact, _, retained = self.exercise("normal", duration=2, budget=Budget(boundary))
        self.assertEqual(exact["reason"], "byte-limit")
        self.assertEqual(retained, persisted)
        self.assertEqual(exact["reservedInputBytes"] + exact["outputBytes"], boundary)

    def test_structure_tap_keeps_only_allowlisted_shapes(self):
        # FLM-377: establish the real iPhone's shape from selector/type/field-presence
        # facts only. Titles, URLs, names and evaluated values stay private.
        result, _, persisted = self.exercise("normal", duration=2, tap=True)
        self.assertEqual((result["reason"], result["cleanup"], result["samples"]), ("stopped", "confirmed", 3))
        self.assertEqual(len(persisted.splitlines()), 3)
        messages = PROOF[-1]["structure"]["messages"]
        flow = [(m["dir"], m["selector"]) for m in messages]
        self.assertEqual(flow[:2], [("out", "_rpc_reportIdentifier:"), ("out", "_rpc_getConnectedApplications:")])
        apps = next(m["apps"] for m in messages if m["selector"] == "_rpc_reportConnectedApplicationList:")
        self.assertEqual((apps["count"], apps["fluux"], apps["hostedByFluux"]), (2, 1, 0))
        self.assertEqual(apps["keys"]["WIRApplicationNameKey"], {"str": 2})
        self.assertEqual(apps["fluuxEntries"][0]["identifierForm"], "pid")
        listings = [m for m in messages if m["selector"] == "_rpc_applicationSentListing:"]
        self.assertEqual([m["forFluux"] for m in listings], [False, True])
        self.assertNotIn("pages", listings[0])
        pages = listings[1]["pages"]
        self.assertEqual((pages["count"], pages["types"], pages["pageIdTypes"]), (1, {"WIRTypeWebPage": 1}, {"int": 1}))
        self.assertEqual(pages["keys"]["WIRTitleKey"], {"str": 1})
        created = next(m for m in messages if m.get("data", {}).get("method") == "Target.targetCreated")
        self.assertEqual((created["destination"], created["data"]["targetInfo"]["type"]), ("sender", "page"))
        self.assertEqual([m["expression"] for m in messages if "expression" in m][:3], ["present", "install", "sample"])
        replies = [m["data"]["inner"]["result"]["remote"] for m in messages
                   if m.get("data", {}).get("method") == "Target.dispatchMessageFromTarget"]
        self.assertEqual([(r["type"], r["valueType"]) for r in replies[:3]],
                         [("boolean", "bool"), ("boolean", "bool"), ("object", "dict")])
        for leaked in ("PRIVATE-CANARY", "hello", "https://example.invalid/x"):
            with self.subTest(leaked=leaked), self.assertRaises(ValueError):
                assert_sanitized({"messages": [{"selector": leaked}]})

    def test_structure_tap_does_not_change_reader_outcomes(self):
        # Observation must never alter what the reader receives or decides.
        for mode in ("fragmented", "xml", "malformed", "missing-listing", "eval-error", "wrong-session",
                     "duplicate-app", "multiple-pages", "destroyed-before-target", "preexisting", "partial"):
            with self.subTest(mode=mode):
                plain, _, plain_saved = self.exercise(mode, duration=.65 if mode != "partial" else .15)
                observed, _, observed_saved = self.exercise(mode, duration=.65 if mode != "partial" else .15,
                                                            tap=True)
                same = ("reason", "phase", "fault", "cleanup", "samples", "discarded", "receivedBytes",
                        "reservedInputBytes")
                self.assertEqual({k: plain[k] for k in same}, {k: observed[k] for k in same})
                self.assertEqual(plain_saved, observed_saved)
                self.assertGreater(observed["outputBytes"], plain["outputBytes"])
        partial = PROOF[-1]["structure"]["partial"]
        self.assertEqual(partial, [{"dir": "in", "bytes": 2048, "received": 6}])

    def test_structure_tap_is_bounded(self):
        result, _, _ = self.exercise("normal", duration=2, tap=2)
        structure = PROOF[-1]["structure"]
        self.assertEqual(result["reason"], "stopped")
        self.assertEqual(len(structure["messages"]), 2)
        self.assertGreater(structure["omitted"], 0)
        with self.assertRaises(ValueError):
            StructureTap(None, Budget(), limit=129)

    def test_schema_rejects_private_numeric_and_stack_fields(self):
        for key, value in [("mountedRows", True), ("elapsedMs", float("nan")),
                           ("errors", [PRIVATE]), ("stackFrames", [{"functionName": PRIVATE}])]:
            with self.subTest(key=key):
                sample = copy.deepcopy(SAMPLES[0])
                sample[key] = value
                with self.assertRaises(Boundary):
                    sanitize_sample(sample)


if __name__ == "__main__":
    outcome = unittest.main(exit=False, verbosity=2)
    print(json.dumps({"tests": outcome.result.testsRun,
                      "success": outcome.result.wasSuccessful(), "cases": PROOF}))
    if not outcome.result.wasSuccessful():
        sys.exit(1)
