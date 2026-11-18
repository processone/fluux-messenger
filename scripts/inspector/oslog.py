"""Restricted host reader for the iPhone's framed process-log relay; no discovery.

The caller supplies an already-authorized, exclusive, blocking stream for
com.apple.os_trace_relay, such as open_service(..., service="os-trace-relay").
Only this module reads or writes it. Each record is checked where it lies, and
only fixed metadata leaves: host and device time, the record's PID, its level and
code-owned labels for the process, subsystem and category. Messages, paths, image
names, UUIDs, thread identifiers and every other remote string are never copied.
Wire shapes follow libimobiledevice (src/ostrace.c, tools/idevicesyslog.c) and
pymobiledevice3 (services/os_trace.py); see README.md, Framed process logs.
"""

import json
import os
import plistlib
import socket
import stat
import struct
import threading
import time

from reader import Boundary, describe_fault

# The one request this module sends. Both references start the stream with
# payload, historical, call stack and debug flags (0x3C); debug is left out here
# because it only adds volume to a shared five-MiB budget.
STREAM_FLAGS = 0x04 | 0x08 | 0x10
MESSAGE_FILTER = 0xFFFF
ALL_PROCESSES = -1
# A reply is one small status dictionary; a record is a 129-byte header plus a
# process path, image path, message, subsystem and category.
REPLY_MAX = 4096
RECORD_MAX = 16 * 1024
# Only the fields named here are unpacked; the UUIDs, activity identifiers, mach
# time, thread and image offset between them are skipped ("x") and never read.
HEADER = struct.Struct("<BIIIQ16xH16xQIxB6x8x8x16xHI4xII4x")
RECORD_MARKER = 2
RECORD_TYPES = frozenset({2, 8})
MAX_PIDS = 1024
LEVELS = {0x00: "default", 0x01: "info", 0x02: "debug", 0x10: "error", 0x11: "fault"}
# Fluux's iOS executable (productName "Fluux") inside its app container.
APP_SUFFIX = b"/Fluux.app/Fluux"
# WebKit's helper processes, as XPC services or as system extensions.
WEBKIT_PROCESSES = {
    b"com.apple.WebKit.WebContent": "webkit-content", b"WebContentExtension": "webkit-content",
    b"com.apple.WebKit.Networking": "webkit-networking", b"NetworkingExtension": "webkit-networking",
    b"com.apple.WebKit.GPU": "webkit-gpu", b"GPUExtension": "webkit-gpu",
}
SUBSYSTEMS = {b"com.apple.WebKit": "webkit", b"net.processone.fluux": "fluux"}
# WebKit's release-log channels about process lifecycle, loading and visibility,
# and Fluux's own os_log categories. Any other category is reported as "other".
CATEGORIES = {
    "webkit": {name: name.decode() for name in (
        b"ActivityState", b"Loading", b"MemoryPressure", b"Process", b"ProcessSuspension",
        b"ProcessSwapping", b"ViewState")},
    "fluux": {b"hinge": "hinge", b"notification": "notification"},
}


def process_label(path):
    """A fixed label for a listed process's executable path, else None."""
    if path.startswith(b"/") and path.endswith(APP_SUFFIX):
        return "fluux"
    if path.startswith(b"/System/"):
        return WEBKIT_PROCESSES.get(path.rsplit(b"/", 1)[-1])
    return None


def _string(body, start, size, *, interior):
    """Check a NUL-terminated region in place; return its text without the NUL.

    interior=False checks only the terminator, so a message is never scanned.
    """
    if not size:
        return None
    end = start + size - 1
    if body[end] != 0 or (interior and body.find(b"\0", start, end) != -1):
        raise Boundary("record-boundary")
    return bytes(body[start:end]) if interior else None


def parse_record(body):
    """Check one relay record and return its code-owned facts.

    Returns None for a well-framed record of an unknown type, which is dropped
    unread. Otherwise returns (pid, process label or None, seconds, microseconds,
    level, subsystem label, category label, trailing byte count). Any structural
    doubt raises Boundary with a fixed reason; the message is never decoded.
    """
    if len(body) < HEADER.size:
        raise Boundary("record-boundary")
    (marker, kind, header_size, pid, procid, path_n, seconds, micros, level,
     image_n, message_n, subsystem_n, category_n) = HEADER.unpack_from(body)
    if marker != RECORD_MARKER:
        raise Boundary("record-boundary")
    if kind not in RECORD_TYPES:
        return None
    if header_size != HEADER.size or path_n < 2 or seconds > 0xFFFFFFFF or micros >= 1_000_000:
        raise Boundary("record-boundary")
    end = HEADER.size + path_n + image_n + message_n + subsystem_n + category_n
    if end > len(body):
        raise Boundary("record-boundary")
    if not 0 < pid <= 0x7FFFFFFF or procid != pid:
        raise Boundary("pid-boundary")
    offset = HEADER.size
    path = _string(body, offset, path_n, interior=True)
    offset += path_n
    _string(body, offset, image_n, interior=False)
    offset += image_n
    _string(body, offset, message_n, interior=False)
    offset += message_n
    subsystem = _string(body, offset, subsystem_n, interior=True)
    offset += subsystem_n
    category = _string(body, offset, category_n, interior=True)
    subsystem_label = None if subsystem is None else SUBSYSTEMS.get(subsystem, "other")
    category_label = None if category is None else CATEGORIES.get(subsystem_label, {}).get(category, "other")
    return (pid, process_label(path), seconds, micros, LEVELS.get(level, "other"),
            subsystem_label, category_label, len(body) - end)


class LogReader:
    """Single-use reader. run() returns only local, enumerated stop statistics.

    The output must be a regular private file, opened by the caller. Duration is
    capped at 120 seconds and shares the caller's stop event and Budget with the
    inspector Reader. Only records from Fluux's app process and WebKit's helper
    processes are written; every other record is checked, counted and dropped.
    """

    def __init__(self, service_socket, budget):
        self.sock = service_socket
        self.budget = budget
        self.used = False
        self.started = False
        self.streaming = False
        self.read_desynchronized = False
        self.write_desynchronized = False
        self.received = 0
        self.records = 0
        self.emitted = 0
        self.discarded = 0
        self.unknown_types = 0
        self.trailing = 0
        self.labels = {}
        self.result = None

    def _check(self):
        if time.monotonic() >= self.deadline:
            raise Boundary("time-limit")
        if self.stop.is_set():
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

    def _frame(self):
        """Read one type byte and length; the caller then owes its whole body."""
        if self.read_desynchronized:
            raise Boundary("protocol-boundary")
        head = self._read(5)
        if head[0] == 1:
            return 1, struct.unpack_from(">I", head, 1)[0]
        if head[0] == 2:
            return 2, struct.unpack_from("<I", head, 1)[0]
        raise Boundary("protocol-boundary")

    def _body(self, size):
        try:
            return self._read(size)
        except BaseException:
            self.read_desynchronized = True
            raise

    def _send(self, data):
        packet = memoryview(data)
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

    def _start(self, pid):
        request = plistlib.dumps({"Request": "StartActivity", "MessageFilter": MESSAGE_FILTER,
                                  "Pid": ALL_PROCESSES if pid is None else pid,
                                  "StreamFlags": STREAM_FLAGS})
        self._send(struct.pack(">I", len(request)) + request)
        kind, size = self._frame()
        if kind != 1 or not 0 < size <= REPLY_MAX:
            raise Boundary("protocol-boundary")
        reply = plistlib.loads(bytes(self._body(size)))
        # The status is compared, never copied: a refusal keeps no remote text.
        if type(reply) is not dict or reply.get("Status") != "RequestSuccessful":
            raise Boundary("relay-refused")

    def _attribute(self, pid, label, only):
        if only is not None and pid != only:
            raise Boundary("pid-boundary")
        if label is None:
            return
        known = self.labels.get(pid)
        if known is None:
            if len(self.labels) >= MAX_PIDS:
                raise Boundary("pid-boundary")
            self.labels[pid] = label
        elif known != label:
            # One PID cannot speak for two listed processes in one capture.
            raise Boundary("pid-boundary")

    def _phase(self):
        if not self.started:
            return "output"
        return "streaming" if self.streaming else "start"

    def run(self, output, *, stop=None, duration=120, pid=None):
        """Stream records until the deadline, the shared stop event or a boundary.

        pid restricts the relay to one process (such as Fluux's, from the
        inspector's PID:n identity) and every record must then carry it; None
        streams all processes and keeps only the listed ones.
        """
        if self.used:
            raise ValueError("single-use-reader")
        if pid is not None and (type(pid) is not int or not 0 < pid <= 0x7FFFFFFF):
            raise ValueError("invalid-pid")
        self.used = True
        self.stop = stop if stop is not None else threading.Event()
        self.deadline = time.monotonic() + min(120, max(0, duration))
        reason = "protocol-boundary"
        phase, fault = "output", {"class": "other"}
        interrupted = None
        started = time.monotonic()
        try:
            mode = os.fstat(output.fileno())
            if (not stat.S_ISREG(mode.st_mode) or mode.st_mode & 0o077
                    or mode.st_size != 0 or output.tell() != 0):
                raise Boundary("unsafe-output")
            self.started = True
            self._start(pid)
            self.streaming = True
            while True:
                self._check()
                if self.budget.exhausted():
                    raise Boundary("byte-limit")
                kind, size = self._frame()
                if kind != 2:
                    raise Boundary("protocol-boundary")
                if not HEADER.size <= size <= RECORD_MAX:
                    raise Boundary("record-boundary")
                body = self._body(size)
                received_at = time.monotonic()
                self.records += 1
                facts = parse_record(body)
                del body
                if facts is None:
                    self.unknown_types += 1
                    continue
                record_pid, label, seconds, micros, level, subsystem, category, trailing = facts
                self._attribute(record_pid, label, pid)
                if trailing:
                    self.trailing += 1
                if label is None:
                    self.discarded += 1
                    continue
                # Rebuilt from code-owned values only; no remote mapping is copied.
                line = {"elapsedMs": round((received_at - started) * 1000, 1),
                        "timeUs": seconds * 1_000_000 + micros, "pid": record_pid, "level": level,
                        "process": label, "subsystem": subsystem, "category": category}
                encoded = (json.dumps(line, allow_nan=False, separators=(",", ":")) + "\n").encode()
                self._check()
                self.budget.charge(len(encoded), output=True)
                output.write(encoded)
                output.flush()
                self.emitted += 1
        except Boundary as error:
            reason = error.args[0]
            phase, fault = self._phase(), describe_fault(error, source=__file__)
        except KeyboardInterrupt as error:
            reason, interrupted = "stopped", error
            phase, fault = self._phase(), describe_fault(error, source=__file__)
        except Exception as error:
            # No exception repr, logger, traceback, record bytes or free text.
            reason = "protocol-boundary"
            phase, fault = self._phase(), describe_fault(error, source=__file__)
        finally:
            # Signal the other collector readers first. Closing the connection
            # ends the relay's stream; there is no remote state to remove.
            self.stop.set()
            try:
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
        pids = {}
        for record_pid, label in self.labels.items():
            pids.setdefault(label, []).append(record_pid)
        self.result = {"reason": reason, "phase": phase, "fault": fault,
                       "records": self.records, "emitted": self.emitted, "discarded": self.discarded,
                       "unknownTypes": self.unknown_types, "trailingRecords": self.trailing,
                       "pids": {label: sorted(values) for label, values in sorted(pids.items())},
                       "receivedBytes": self.received, "reservedInputBytes": self.budget.input,
                       "outputBytes": self.budget.output,
                       "elapsedSeconds": round(time.monotonic() - started, 4)}
        if interrupted is not None:
            raise interrupted
        return self.result
