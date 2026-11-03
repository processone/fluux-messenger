"""FLM-366: explicit-consent integration API, not a live capture launcher.

Only open_service() starts the native worker. Import/build/proof never use a phone.
The worker handles existing pairing in memory; Python sees only service bytes and
fixed statuses. Give the returned single-owner interface directly to Reader.
"""

import math
from pathlib import Path
import socket
import struct
import subprocess
import threading
import time

START_CREDIT = 256 * 1024
CREDIT = 64 * 1024
BLOCK = 64 * 1024
# E1: leave bounded local IPC margin after the native service wait. In particular,
# a Reader's final 1ms no-data read must not destroy the stream before cleanup.
# FLM-377: the margin must also absorb scheduling delay. A background process's
# short timers ran up to 150 ms late on the fleet's Mac, and a 25 ms margin turned
# a healthy late reply into a closed stream on the real iPhone. A stopped worker is
# still detected and reaped well within a second.
CONTROL_GRACE = .5
HEADER = struct.Struct('>cII')
REQUEST = struct.Struct('>cIII')


class ServiceError(OSError):
    """Fixed local categories only, never a remote value or exception repr."""


def _seconds(value, ceiling):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= ceiling:
        raise ValueError('invalid-service-timeout')
    return value


class ServiceStream:
    """Socket-compatible subset used by Reader: no fileno(), dup() or makefile().

    Pull-based reads avoid an unaccounted proxy read-ahead buffer. TLS can buffer
    only prepaid input. A native no-data timeout is retryable; any partially
    completed local exchange fails closed, so a timed-out write is never repeated.
    Caller code must not log this stream's raw authorized inspector bytes.
    """

    def __init__(self, control, process, budget, deadline):
        self._control, self._process, self._budget = control, process, budget
        self._deadline, self._timeout = deadline, 1.0
        self._paid, self._used = START_CREDIT, 0
        self._lock = threading.Lock()
        self.closed = False

    def _read_exact(self, n):
        data = bytearray()
        while len(data) < n:
            # One absolute control deadline includes the fixed IPC grace;
            # partial reads never reset it or spend another caller timeout.
            remaining = self._operation_end - time.monotonic()
            if remaining <= 0:
                raise ServiceError('service-deadline')
            self._control.settimeout(remaining)
            chunk = self._control.recv(n - len(data))
            if not chunk:
                raise ServiceError('service-closed')
            data.extend(chunk)
        return data

    def _response(self, *, reading=False, maximum=0):
        status, n, used = HEADER.unpack(self._read_exact(HEADER.size))
        if used < self._used or used > self._paid or n > maximum:
            raise ServiceError('service-protocol')
        self._used = used
        if status == b'T' and n == 0:
            return None
        if status != b'O':
            raise ServiceError({b'D': 'device-boundary', b'P': 'pairing-unavailable',
                                b'L': 'session-unavailable', b'S': 'service-unavailable'}
                               .get(status, 'service-closed'))
        return bytes(self._read_exact(n)) if reading else n

    def settimeout(self, seconds):
        self._timeout = _seconds(seconds, 1)

    def _exchange(self, kind, n, data=b''):
        if not self._lock.acquire(blocking=False):
            raise ServiceError('service-concurrent-use')
        try:
            if self.closed:
                raise ServiceError('service-closed')
            service_end = min(self._deadline, time.monotonic() + self._timeout)
            self._operation_end = service_end + CONTROL_GRACE
            credit = max(0, CREDIT - (self._paid - self._used))
            # The budget owns its exception type. Close on failure, but keep it
            # outside the transport wrapper so every caller receives it unchanged.
            self._budget.charge(credit)
            self._paid += credit
            try:
                remaining = service_end - time.monotonic()
                if remaining <= 0:
                    raise ServiceError('service-deadline')
                self._control.settimeout(self._operation_end - time.monotonic())
                self._control.sendall(REQUEST.pack(kind, n, max(1, int(remaining * 1000)), credit) + data)
                return self._response(reading=kind == b'R', maximum=n)
            except BaseException as error:
                if isinstance(error, (KeyboardInterrupt, SystemExit, ServiceError)):
                    raise
                raise ServiceError('service-io') from None
        except BaseException:
            self.close()
            raise
        finally:
            self._lock.release()

    def recv(self, size):
        if type(size) is not int or size < 0:
            raise ValueError('invalid-service-size')
        if size == 0:
            return b''
        result = self._exchange(b'R', min(size, BLOCK))
        if result is None:
            raise socket.timeout('service-idle')
        if not result:
            self.close()
            raise ServiceError('service-closed')
        return result

    def send(self, data):
        view = memoryview(data).cast('B')
        if not view:
            return 0
        n = min(len(view), BLOCK)
        result = self._exchange(b'W', n, bytes(view[:n]))
        if result != n:
            self.close()
            raise ServiceError('service-write')
        return result

    def shutdown(self, how):
        # Reader requests SHUT_RDWR. Half-closing a TLS/RPC exchange is unsupported.
        if how != socket.SHUT_RDWR:
            raise ValueError('invalid-service-shutdown')
        self.close()

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self._control.setblocking(False)
            self._control.send(REQUEST.pack(b'X', 0, 0, 0))
        except OSError:
            pass
        finally:
            self._control.close()
        try:
            self._process.wait(timeout=.1)
        except subprocess.TimeoutExpired:
            self._process.kill()
            # A killed child still must be reaped, not left as an owned job.
            self._process.wait()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def open_service(worker, device_id, budget, *, startup_timeout=5, lifetime=120.5,
                 mux_socket='/var/run/usbmuxd'):
    """Open only the exact, already-authorized USB phone's Web Inspector service.

    Requires FLM-350's separate attachment/device consent before real use. Never
    infer consent here. mux_socket is a private disposable socket in tests; live
    callers keep the system default. No environment-based daemon redirection.
    Startup reserves 256 KiB in the existing attempt's Budget before any I/O.
    Lifetime includes reader cleanup; supply the original remaining host deadline.
    No retry, reconnect, trust prompt, pairing write, app launch or page request.
    """
    _seconds(startup_timeout, 5)
    _seconds(lifetime, 121)
    deadline = time.monotonic() + lifetime
    if type(device_id) is not str or not 1 <= len(device_id) <= 128 or not device_id.isascii() or not all(
            ch.isalnum() or ch == '-' for ch in device_id):
        raise ValueError('invalid-device-id')
    path = str(mux_socket).encode()
    if not path.startswith(b'/') or b'\0' in path or not 0 < len(path) < 104:
        raise ValueError('invalid-mux-socket')
    worker = str(Path(worker).resolve(strict=True))
    budget.charge(START_CREDIT)
    parent, child = socket.socketpair()
    process = None
    stream = None
    try:
        process = subprocess.Popen([worker, str(child.fileno())], pass_fds=(child.fileno(),),
                                   start_new_session=True,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, cwd=Path(worker).parent,
                                   env={'OPENSSL_CONF': '/dev/null'})
        child.close()
        stream = ServiceStream(parent, process, budget, deadline)
        stream._timeout = min(startup_timeout, lifetime)
        stream._operation_end = min(deadline, time.monotonic() + stream._timeout)
        parent.settimeout(stream._timeout)
        identity = device_id.encode()
        remaining = max(1, math.ceil((deadline - time.monotonic()) * 1000))
        parent.sendall(struct.pack('>III', remaining, len(identity), len(path)) + identity + path)
        stream._response()
        stream._timeout = 1.0
        return stream
    except BaseException as error:
        if stream:
            stream.close()
        else:
            parent.close()
            if process:
                process.kill()
                process.wait()
        if isinstance(error, (KeyboardInterrupt, SystemExit, ServiceError)):
            raise
        raise ServiceError('service-startup') from None
    finally:
        child.close()
