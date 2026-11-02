"""FLM-349/351 owns these invariants; local wire peers are NOT iPhone proof.

Samples arrive from actual disposable WebKit measurements in prove.mjs.
Wire shapes follow pymobiledevice3 services/webinspector.py; the peer simulates
webinspectord, including unwanted app metadata and asynchronous console events.
"""
import contextlib
import copy
import io
import json
import os
import plistlib
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest

from reader import BUNDLE, CAP, Budget, Boundary, Reader, PRESENT, SAMPLER, SAMPLE, REMOVE, sanitize_sample

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
    def __init__(self, sock, mode, stop):
        self.sock, self.mode, self.stop = sock, mode, stop
        self.requests, self.expressions, self.times = [], [], []
        self.errors = []
        self.closed = False
        self.sender = None
        self.released = threading.Event()
        self.target = "page-1"
        self.total_sent = 0
        self.sample_index = 0

    def send(self, selector, arg):
        data = frame(selector, arg)
        if self.mode == "xml":
            body = plistlib.dumps({"__selector": selector, "__argument": arg})
            data = struct.pack(">I", len(body)) + body
        self.total_sent += len(data)
        self.sock.sendall(data)

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
                    self.listing(pages=2 if self.mode == "multiple-pages" else 1)
                elif sel == "_rpc_forwardSocketSetup:":
                    self.sender = arg["WIRSenderKey"]
                    assert arg["WIRAutomaticallyPause"] is False
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
                    if exp == REMOVE and self.mode == "frozen":
                        continue
                    if exp == SAMPLE:
                        self.times.append(time.monotonic())
                        if self.sample_index == 3 and self.mode in ("normal", "xml", "fragmented"):
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
                        if self.mode == "target-changed":
                            self.data({"method": "Target.targetDestroyed", "params": {"targetId": self.target}})
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
    def exercise(self, mode, *, duration=.65, budget=None, cleanup=.15):
        client, server = socket.socketpair()
        if mode == "blocked-send":
            client.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1024)
        stop = threading.Event()
        peer = Peer(server, mode, stop)
        thread = threading.Thread(target=peer.run)
        thread.start()
        class FragmentedSocket:
            # Bound each actual socket read, including the length prefix.
            def recv(self, count):
                return client.recv(min(count, 7))

            def __getattr__(self, name):
                return getattr(client, name)

        reader = Reader(FragmentedSocket() if mode == "fragmented" else client, budget or Budget())
        stdout, stderr = io.StringIO(), io.StringIO()
        try:
            with tempfile.TemporaryFile() as output, contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
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
        self.assertNotIn(PRIVATE, persisted.decode() + stdout.getvalue() + stderr.getvalue() + json.dumps(result))
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
        self.assertLessEqual(result["reservedInputBytes"] + result["outputBytes"], reader.budget.limit)
        self.assertLessEqual(result["receivedBytes"], result["reservedInputBytes"])
        self.assertLess(result["elapsedSeconds"], duration + cleanup + .35)
        for request in peer.requests:
            if request["selector"] in ("_rpc_forwardGetListing:", "_rpc_forwardSocketSetup:"):
                self.assertEqual(request["app"], "PID:321")
        PROOF.append({"case": mode, "result": result, "retained": [json.loads(line) for line in persisted.splitlines()],
                      "selectors": [r["selector"] for r in peer.requests], "commands": peer.expressions,
                      "sampleIntervals": [round(b - a, 4) for a, b in zip(peer.times, peer.times[1:])],
                      "peerClosed": peer.closed})
        return result, peer, persisted

    def test_normal_filtered_sampling_and_detach(self):
        result, peer, persisted = self.exercise("normal", duration=2)
        self.assertEqual(result["reason"], "stopped")
        self.assertEqual(result["cleanup"], "confirmed")
        self.assertEqual(result["samples"], 3)
        self.assertEqual(len(persisted.splitlines()), 3)
        self.assertTrue(all(b - a >= .24 for a, b in zip(peer.times, peer.times[1:])))
        self.assertEqual(peer.expressions[-1], "remove")
        self.assertIn("_rpc_forwardDidClose:", [r["selector"] for r in peer.requests])
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
        for mode, reason in [("duplicate-app", "identity-boundary"), ("multiple-pages", "page-boundary"),
                             ("wrong-session", "session-boundary"), ("wrong-app", "session-boundary"),
                             ("identity-changed", "identity-boundary"), ("page-changed", "page-boundary"),
                             ("target-changed", "target-boundary")]:
            with self.subTest(mode=mode):
                result, _, persisted = self.exercise(mode)
                self.assertEqual(result["reason"], reason)
                self.assertEqual(persisted, b"")

    def test_payloads_do_not_escape_error_paths(self):
        for mode, reason in [("malformed", "protocol-boundary"), ("eval-error", "evaluation-failed"),
                             ("bad-sample", "invalid-sample"), ("disconnect", "disconnected")]:
            with self.subTest(mode=mode):
                result, _, persisted = self.exercise(mode)
                self.assertEqual(result["reason"], reason)
                self.assertEqual(persisted, b"")

    def test_real_time_hung_partial_and_frozen_cleanup(self):
        for mode in ("silent", "partial", "no-fluux", "frozen"):
            with self.subTest(mode=mode):
                result, _, _ = self.exercise(mode, duration=.15)
                self.assertEqual(result["reason"], "time-limit")
                self.assertEqual(result["cleanup"], "unconfirmed" if mode == "frozen" else "not-installed")

    def test_preexisting_sampler_is_not_removed(self):
        result, peer, persisted = self.exercise("preexisting")
        self.assertEqual(result["reason"], "sampler-already-present")
        self.assertEqual(result["cleanup"], "not-installed")
        self.assertEqual(peer.expressions, ["present"])
        self.assertEqual(persisted, b"")

    def test_cleanup_deadline_is_capped(self):
        result, _, _ = self.exercise("frozen", duration=.15, cleanup=5)
        self.assertEqual(result["reason"], "time-limit")
        self.assertEqual(result["cleanup"], "unconfirmed")
        self.assertLess(result["elapsedSeconds"], 1.1)

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
        _, _, persisted = self.exercise("normal", duration=.15, budget=observed)
        self.assertGreater(len(persisted), 0)
        boundary = observed.first_output_boundary
        insufficient = ObservedBudget(boundary - 1)
        limited, peer, retained = self.exercise("normal", duration=.15, budget=insufficient)
        self.assertEqual(limited["reason"], "byte-limit")
        # Cleanup can spend remaining input bytes after the output rejection.
        # The observed first output charge proves it was the write that failed.
        self.assertEqual(insufficient.first_output_boundary, boundary)
        self.assertEqual(limited["outputBytes"], 0)
        self.assertEqual(peer.sample_index, 1)
        self.assertEqual(retained, b"")
        exact, _, retained = self.exercise("normal", duration=.15, budget=Budget(boundary))
        self.assertEqual(exact["reason"], "byte-limit")
        self.assertEqual(retained, persisted)
        self.assertEqual(exact["reservedInputBytes"] + exact["outputBytes"], boundary)

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
    if not outcome.result.wasSuccessful():
        sys.exit(1)
    print(json.dumps({"tests": outcome.result.testsRun, "cases": PROOF}))
