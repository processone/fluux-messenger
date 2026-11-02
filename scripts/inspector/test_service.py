"""FLM-366 owns the opener boundary; peers are disposable, never an iPhone.

Exercises the actual C implementation, OpenSSL, Unix sockets and unchanged Reader.
Pair records/certificates below are generated for this run, not personal fixtures.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import plistlib
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

from reader import CAP, Budget, Boundary, Reader, PRESENT, SAMPLER, SAMPLE, REMOVE
from service import open_service, ServiceStream, ServiceError, START_CREDIT

WORKER = Path(sys.argv.pop(1)).resolve()
SAMPLES = json.load(sys.stdin)
PROOF = []
UDID = '00008030-0012345678901234'
PRIVATE = 'DISPOSABLE-PRIVATE-CANARY'
ROOT = tempfile.TemporaryDirectory(prefix='flm366-cert-', dir=WORKER.parent)
FILES = Path(ROOT.name)


def command(*args):
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=10)


# Only the disposable TLS peer uses fixture files; production uses memory BIOs.
command('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=Disposable root', '-keyout', str(FILES/'root.key'), '-out', str(FILES/'root.pem'))
command('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Disposable device',
        '-keyout', str(FILES/'device.key'), '-out', str(FILES/'device.csr'))
command('openssl', 'x509', '-req', '-in', str(FILES/'device.csr'), '-CA', str(FILES/'root.pem'),
        '-CAkey', str(FILES/'root.key'), '-set_serial', '2', '-days', '1', '-out', str(FILES/'device.pem'))
PAIR = {'HostID': 'A7DD12E1-1F32-4A09-A77D-145355AA67F7',
        'RootCertificate': (FILES/'root.pem').read_bytes(),
        'RootPrivateKey': (FILES/'root.key').read_bytes(),
        'DeviceCertificate': (FILES/'device.pem').read_bytes()}


def exact(sock, n):
    data = b''
    while len(data) < n:
        chunk = sock.recv(n-len(data))
        if not chunk:
            raise EOFError()
        data += chunk
    return data


def read_plist(sock):
    n = struct.unpack('>I', exact(sock, 4))[0]
    assert 0 < n <= 65536
    return plistlib.loads(exact(sock, n))


def send_plist(sock, value):
    body = plistlib.dumps(value, fmt=plistlib.FMT_BINARY)
    sock.sendall(struct.pack('>I', len(body)) + body)


class FragmentedTLS:
    """Real OpenSSL server with a deliberately split encrypted application record."""
    def __init__(self, sock, context, cut, release):
        self.sock, self.cut, self.release = sock, cut, release
        self.incoming, self.outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
        self.tls = context.wrap_bio(self.incoming, self.outgoing, server_side=True)
        while True:
            try:
                self.tls.do_handshake()
                self.flush()
                break
            except ssl.SSLWantReadError:
                self.feed()

    def flush(self):
        data = self.outgoing.read()
        if data:
            self.sock.sendall(data)

    def feed(self):
        self.flush()
        data = self.sock.recv(65536)
        if not data:
            raise EOFError()
        self.incoming.write(data)

    def recv(self, n):
        while True:
            try:
                return self.tls.read(n)
            except ssl.SSLWantReadError:
                self.feed()

    def sendall(self, data):
        self.tls.write(data)
        encrypted = self.outgoing.read()
        assert len(encrypted) > 2
        self.sock.sendall(encrypted[:2])
        self.cut.set()
        assert self.release.wait(2)
        self.sock.sendall(encrypted[2:])

    def close(self):
        self.sock.close()


class DevicePeer:
    def __init__(self, mode='echo', *, fragmented=False):
        self.mode, self.fragmented = mode, fragmented
        self.path = '/tmp/flm366-' + uuid.uuid4().hex + '.sock'
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        os.chmod(self.path, 0o600)
        self.server.listen()
        self.server.settimeout(.1)
        self.stop = threading.Event()
        self.changed = threading.Condition()
        self.threads, self.connections, self.requests = [], set(), []
        self.service_ready = threading.Event()
        self.fragment_cut = threading.Event()
        self.release = threading.Event()
        self.errors = []
        self.service_bytes = 0
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(FILES/'device.pem', FILES/'device.key')
        self.context.load_verify_locations(FILES/'root.pem')
        self.context.verify_mode = ssl.CERT_REQUIRED
        self.thread = threading.Thread(target=self.accept)
        self.thread.start()

    def accept(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with self.changed:
                self.connections.add(conn)
            t = threading.Thread(target=self.handle, args=(conn,))
            self.threads.append(t)
            t.start()

    def mux_reply(self, sock, value, tag):
        body = plistlib.dumps(value, fmt=plistlib.FMT_XML)
        sock.sendall(struct.pack('<IIII', len(body)+16, 1, 8, tag) + body)

    def handle(self, conn):
        original = conn
        try:
            conn.settimeout(3)
            h = exact(conn, 16)
            n, version, kind, tag = struct.unpack('<IIII', h)
            assert 16 < n <= 65552 and version == 1 and kind == 8
            request = plistlib.loads(exact(conn, n-16))
            name = request['MessageType']
            with self.changed:
                self.requests.append(name)
            assert name in ('ListDevices', 'ReadPairRecord', 'ReadBUID', 'Connect')
            if self.mode == 'malformed-length':
                conn.sendall(struct.pack('<IIII', 0xffffffff, 1, 8, tag))
                return
            if name == 'ListDevices':
                def device(kind='USB'):
                    return {'DeviceID': 1, 'Properties': {'SerialNumber': UDID, 'ConnectionType': kind,
                                                         'Private': PRIVATE}}
                entries = [device()]
                if self.mode == 'duplicate':
                    entries.append(device())
                if self.mode == 'no-device':
                    entries = []
                if self.mode == 'network':
                    entries = [device('Network')]
                # Unrelated devices are not selected or queried.
                entries.append({'DeviceID': 2, 'Properties': {'SerialNumber': 'other', 'ConnectionType': 'USB'}})
                self.mux_reply(conn, {'DeviceList': entries}, tag)
            elif name == 'ReadPairRecord':
                assert request['PairRecordID'] == UDID
                if self.mode == 'no-pair':
                    self.mux_reply(conn, {'Number': 2, 'Private': PRIVATE}, tag)
                    return
                pair = dict(PAIR)
                if self.mode == 'bad-key':
                    pair['RootPrivateKey'] = PRIVATE.encode()
                if self.mode == 'wrong-pin':
                    pair['DeviceCertificate'] = pair['RootCertificate']
                record = plistlib.dumps(pair, fmt=plistlib.FMT_BINARY)
                if self.mode == 'bad-pair':
                    record = PRIVATE.encode()
                self.mux_reply(conn, {'PairRecordData': record}, tag)
            elif name == 'ReadBUID':
                self.mux_reply(conn, {'BUID': '18D44642-3FDD-481D-BF1E-29879656AD4B'}, tag)
            else:
                assert request['DeviceID'] == 1
                port = socket.ntohs(request['PortNumber'])
                assert port in (62078, 27753)
                self.mux_reply(conn, {'Number': 0}, tag)
                if self.mode == 'stalled-startup':
                    # A real pipe blocked after Connect; killed worker closes it.
                    while conn.recv(1024):
                        pass
                    return
                if port == 62078:
                    p = read_plist(conn)
                    assert p['Request'] == 'StartSession' and p['HostID'] == PAIR['HostID']
                    self.requests.append(p['Request'])
                    if self.mode == 'session-denied':
                        send_plist(conn, {'Request': 'StartSession', 'Error': PRIVATE})
                        return
                    send_plist(conn, {'Request': 'StartSession', 'SessionID': 'disposable-session',
                                      'EnableSessionSSL': True})
                    conn = self.context.wrap_socket(conn, server_side=True)
                    p = read_plist(conn)
                    self.requests.append(p['Request'])
                    assert p['Request'] == 'StartService' and p['Service'] == 'com.apple.webinspector'
                    assert set(p) == {'Request', 'Label', 'Service'}  # No escrow bag or other service.
                    if self.mode == 'service-denied':
                        send_plist(conn, {'Request': 'StartService', 'Error': PRIVATE})
                        return
                    send_plist(conn, {'Request': 'StartService', 'Port': 27753,
                                      'EnableServiceSSL': self.mode != 'plain'})
                    p = read_plist(conn)
                    self.requests.append(p['Request'])
                    assert p['Request'] == 'StopSession'
                    send_plist(conn, {'Request': 'StopSession'})
                else:
                    if self.mode == 'tls-partial':
                        conn = FragmentedTLS(conn, self.context, self.fragment_cut, self.release)
                    elif self.mode != 'plain':
                        conn = self.context.wrap_socket(conn, server_side=True)
                    self.service_ready.set()
                    if self.mode == 'inspector':
                        self.inspector(conn)
                    elif self.mode == 'flood':
                        while True:
                            conn.sendall(b'x' * 65536)
                    elif self.mode == 'blocked-write':
                        self.release.wait(3)
                    else:
                        while True:
                            data = conn.recv(65536)
                            if not data:
                                break
                            self.service_bytes += len(data)
                            if self.mode == 'silent':
                                continue
                            if self.fragmented:
                                for byte in data:
                                    conn.sendall(bytes([byte]))
                            else:
                                conn.sendall(data)
        except (EOFError, OSError):
            # Expected disconnects/TLS alerts, never print a remote exception.
            pass
        except BaseException:
            self.errors.append('peer-invariant')
        finally:
            conn.close()
            original.close()
            with self.changed:
                self.connections.discard(original)
                self.changed.notify_all()

    def inspector(self, conn):
        sender = None
        def event(selector, args):
            send_plist(conn, {'__selector': selector, '__argument': args})
        while True:
            p = read_plist(conn)
            name, arg = p['__selector'], p['__argument']
            self.requests.append(name)
            if name == '_rpc_getConnectedApplications:':
                event('_rpc_reportConnectedApplicationList:', {'WIRApplicationDictionaryKey': {
                    'PID:321': {'WIRApplicationIdentifierKey': 'PID:321',
                                'WIRApplicationBundleIdentifierKey': 'net.processone.fluux'},
                    'PID:654': {'WIRApplicationIdentifierKey': 'PID:654',
                                'WIRApplicationBundleIdentifierKey': 'com.apple.mobilesafari',
                                'WIRApplicationNameKey': PRIVATE}}})
            elif name == '_rpc_forwardGetListing:':
                assert arg['WIRApplicationIdentifierKey'] == 'PID:321'
                event('_rpc_applicationSentListing:', {'WIRApplicationIdentifierKey': 'PID:321', 'WIRListingKey': {
                    '1': {'WIRPageIdentifierKey': 1, 'WIRTypeKey': 'WIRTypeWebPage', 'WIRURLKey': PRIVATE}}})
            elif name == '_rpc_forwardSocketSetup:':
                sender = arg['WIRSenderKey']
                event('_rpc_applicationSentData:', {'WIRApplicationIdentifierKey': 'PID:321',
                    'WIRDestinationKey': sender, 'WIRMessageDataKey': json.dumps({
                        'method': 'Target.targetCreated', 'params': {'targetInfo': {'targetId': 'page-1', 'type': 'page'}}})})
            elif name == '_rpc_forwardSocketData:':
                wrapped = json.loads(arg['WIRSocketDataKey'])
                command = json.loads(wrapped['params']['message'])
                exp = command['params']['expression']
                assert exp in (PRESENT, SAMPLER, SAMPLE, REMOVE)
                value = False if exp == PRESENT else SAMPLES[0] if exp == SAMPLE else True
                event('_rpc_applicationSentData:', {'WIRApplicationIdentifierKey': 'PID:321',
                    'WIRDestinationKey': sender, 'WIRMessageDataKey': json.dumps({'id': command['id'],
                        'result': {'result': {'value': value}}})})
            elif name == '_rpc_forwardDidClose:':
                return

    def wait_closed(self):
        with self.changed:
            assert self.changed.wait_for(lambda: not self.connections, timeout=2), 'peer-not-closed'
        assert not self.errors, self.errors

    def close(self):
        self.release.set()
        self.stop.set()
        self.server.close()
        self.thread.join(2)
        with self.changed:
            for conn in list(self.connections):
                with contextlib.suppress(OSError):
                    conn.shutdown(socket.SHUT_RDWR)
        for t in self.threads:
            t.join(4)
            assert not t.is_alive(), 'peer-thread-not-closed'
        assert not self.thread.is_alive()
        os.unlink(self.path)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class ServiceProof(unittest.TestCase):
    def open(self, peer, budget=None, **options):
        stream = open_service(WORKER, UDID, budget if budget is not None else Budget(), mux_socket=peer.path, **options)
        self.addCleanup(stream.close)
        return stream

    def test_existing_pairing_and_exact_bytes(self):
        for mode in ('echo', 'plain'):
            with self.subTest(mode=mode), DevicePeer(mode, fragmented=True) as peer:
                budget = Budget()
                budget.charge(8192)  # FLM-350's prior charges must remain charged.
                stream = self.open(peer, budget)
                process = stream._process
                payload = b'\x00\x00\x00\x08bplist00' + bytes(range(256))
                self.assertEqual(stream.send(payload), len(payload))
                received = bytearray()
                while len(received) < len(payload):
                    try:
                        received.extend(stream.recv(7))
                    except socket.timeout:
                        continue
                self.assertEqual(received, payload)
                self.assertGreaterEqual(budget.input, START_CREDIT + 8192)
                stream.close()
                stream.close()
                self.assertIsNotNone(process.poll())
                peer.wait_closed()
                self.assertIn('StopSession', peer.requests)
                self.assertEqual(peer.requests.count('ReadPairRecord'), 1)
                self.assertEqual(peer.requests.count('StartSession'), 1)
                self.assertEqual(peer.requests.count('StartService'), 1)
        PROOF.append({'scenario': 'existing-pairing', 'result': 'pass', 'wire': 'TLS-pinned and explicit plain service',
                      'priorChargesPreserved': True, 'fragmentedBytesEqual': True, 'workerReaped': True})

    def test_closed_startup_boundaries(self):
        for mode, category in [('no-pair', 'pairing-unavailable'), ('bad-pair', 'pairing-unavailable'),
                               ('bad-key', 'pairing-unavailable'), ('wrong-pin', 'session-unavailable'),
                               ('session-denied', 'session-unavailable'), ('service-denied', 'service-unavailable'),
                               ('duplicate', 'device-boundary'), ('network', 'device-boundary'),
                               ('no-device', 'device-boundary'), ('malformed-length', 'device-boundary')]:
            with self.subTest(mode=mode), DevicePeer(mode) as peer:
                with self.assertRaises(ServiceError) as caught:
                    self.open(peer)
                self.assertEqual(str(caught.exception), category)
                peer.wait_closed()
                self.assertNotIn('Pair', peer.requests)
                self.assertNotIn('SavePairRecord', peer.requests)
        PROOF.append({'scenario': 'existing-pairing', 'result': 'pass', 'startupRejections': 10, 'noNewTrust': True})

    def test_reader_integration(self):
        with DevicePeer('inspector') as peer, tempfile.TemporaryFile('w+b', dir=WORKER.parent) as output:
            budget = Budget()
            stream = self.open(peer, budget)
            reader = Reader(stream, budget)
            result = reader.run(output, duration=.6)
            self.assertEqual(result['reason'], 'time-limit')
            self.assertEqual(result['cleanup'], 'confirmed')
            self.assertGreater(result['samples'], 0)
            output.seek(0)
            saved = output.read()
            self.assertNotIn(PRIVATE.encode(), saved)
            self.assertEqual(json.loads(saved.splitlines()[0])['mountedRows'], SAMPLES[0]['mountedRows'])
            self.assertIsNotNone(stream._process.poll())
            peer.wait_closed()
            self.assertIn('_rpc_forwardDidClose:', peer.requests)
            PROOF.append({'scenario': 'reader-stream', 'result': 'pass', 'reader': result,
                          'sampleMatchesDisposableWebKit': True, 'workerReaped': True})

    def test_deadlines_and_idle_timeout(self):
        with DevicePeer('stalled-startup') as peer:
            start = time.monotonic()
            with self.assertRaises(ServiceError):
                self.open(peer, startup_timeout=.1)
            elapsed = time.monotonic() - start
            self.assertLess(elapsed, 1)
            peer.wait_closed()
        with DevicePeer('silent') as peer:
            stream = self.open(peer)
            stream.settimeout(.025)
            with self.assertRaises(socket.timeout):
                stream.recv(4)
            self.assertFalse(stream.closed)  # A complete no-data response is safe to retry.
            stream.close()
            peer.wait_closed()
        with DevicePeer() as peer:
            stream = self.open(peer, lifetime=.2)
            stream._process.wait(timeout=1)
            self.assertIsNotNone(stream._process.returncode)
            with self.assertRaises(ServiceError):
                stream.recv(4)
            self.assertTrue(stream.closed)
            peer.wait_closed()
        PROOF.append({'scenario': 'bounded-lifecycle', 'result': 'pass', 'stalledStartupSeconds': round(elapsed, 4),
                      'safeNoDataTimeout': True, 'idleWorkerExpired': True})

    def test_partial_tls_and_unresponsive_worker(self):
        with DevicePeer('tls-partial') as peer:
            stream = self.open(peer)
            stream.settimeout(.025)
            stream.send(b'framing-compatible')
            self.assertTrue(peer.fragment_cut.wait(1))
            with self.assertRaises(socket.timeout):
                stream.recv(64)
            self.assertFalse(stream.closed)
            peer.release.set()
            result = b''
            while not result:
                try:
                    result = stream.recv(64)
                except socket.timeout:
                    continue
            self.assertEqual(result, b'framing-compatible')
            stream.close()
            peer.wait_closed()
        with DevicePeer() as peer:
            import signal
            stream = self.open(peer)
            os.kill(stream._process.pid, signal.SIGSTOP)
            stream.settimeout(.025)
            start = time.monotonic()
            with self.assertRaises(ServiceError):
                stream.recv(4)
            self.assertTrue(stream.closed)
            self.assertIsNotNone(stream._process.poll())
            elapsed = time.monotonic() - start
            self.assertLess(elapsed, 1)
            peer.wait_closed()
        PROOF.append({'scenario': 'reader-stream', 'result': 'pass', 'splitEncryptedRecordPreserved': True,
                      'unresponsiveWorkerReapedSeconds': round(elapsed, 4)})

    def test_shared_budget_exhaustion_and_flood(self):
        budget = Budget(START_CREDIT - 1)
        with DevicePeer() as peer:
            with self.assertRaises(Boundary):
                self.open(peer, budget)
            self.assertEqual(peer.requests, [])
        with DevicePeer('flood') as peer:
            budget = Budget(CAP)
            budget.charge(8192, output=True)
            stream = self.open(peer, budget)
            # Reserve other collector work concurrently, before exhausting wire credit.
            t = threading.Thread(target=lambda: budget.charge(65536))
            t.start(); t.join()
            total = 0
            with self.assertRaises((Boundary, ServiceError)):
                while True:
                    try:
                        total += len(stream.recv(65536))
                    except socket.timeout:
                        continue
            self.assertTrue(stream.closed)
            self.assertLessEqual(budget.input + budget.output, budget.limit)
            self.assertLess(total, budget.limit)
            peer.wait_closed()
            PROOF.append({'scenario': 'shared-budget', 'result': 'pass', 'chargedBytes': budget.input,
                          'limitBytes': budget.limit, 'returnedBytes': total, 'closedBeforeOvershoot': True})

    def test_blocked_write_and_close(self):
        with DevicePeer('blocked-write') as peer:
            stream = self.open(peer)
            stream.settimeout(.05)
            start = time.monotonic()
            # Peer never consumes service input. Native output has a fixed cap too.
            with self.assertRaises(ServiceError):
                for _ in range(100):
                    stream.send(b'x' * 65536)
            self.assertTrue(stream.closed)
            self.assertIsNotNone(stream._process.poll())
            elapsed = time.monotonic() - start
            self.assertLess(elapsed, 2)
            peer.release.set()
            peer.wait_closed()
            PROOF.append({'scenario': 'bounded-lifecycle', 'result': 'pass', 'blockedWriteSeconds': round(elapsed, 4),
                          'workerReaped': True})

    def test_silence_and_exclusive_interface(self):
        # Capture the real executable's diagnostics with an invalid private config.
        parent, child = socket.socketpair()
        p = subprocess.Popen([str(WORKER), str(child.fileno())], pass_fds=(child.fileno(),),
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        child.close()
        parent.sendall(struct.pack('>III', 1, 129, 1) + PRIVATE.encode())
        parent.close()
        stdout, stderr = p.communicate(timeout=2)
        self.assertEqual((stdout, stderr), (b'', b''))
        # Capture real success and private-error diagnostics, not just bad arguments.
        for mode in ('echo', 'session-denied'):
            with DevicePeer(mode) as peer:
                parent, child = socket.socketpair()
                p = subprocess.Popen([str(WORKER), str(child.fileno())], pass_fds=(child.fileno(),),
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     cwd=WORKER.parent, env={'OPENSSL_CONF': '/dev/null'})
                child.close()
                stream = ServiceStream(parent, p, Budget(), time.monotonic()+2)
                self.addCleanup(stream.close)
                stream._operation_end = time.monotonic()+1
                identity, path = UDID.encode(), peer.path.encode()
                parent.sendall(struct.pack('>III', 2000, len(identity), len(path))+identity+path)
                if mode == 'echo':
                    stream._response()
                    stream.send(b'authorized-bytes')
                else:
                    with self.assertRaises(ServiceError):
                        stream._response()
                stream.close()
                self.assertEqual((p.stdout.read(), p.stderr.read()), (b'', b''))
                p.stdout.close(); p.stderr.close()
                peer.wait_closed()
        with DevicePeer() as peer:
            before = set(WORKER.parent.iterdir())
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
                from unittest.mock import patch
                with patch.dict(os.environ, {'SSLKEYLOGFILE': str(WORKER.parent/'forbidden-key-log'),
                                             'USBMUXD_SOCKET_ADDRESS': '/var/run/usbmuxd',
                                             'LIBIMOBILEDEVICE_DEBUG': '9'}):
                    stream = self.open(peer)
                stream._lock.acquire()
                try:
                    with self.assertRaises(ServiceError) as caught:
                        stream.recv(4)
                    self.assertEqual(str(caught.exception), 'service-concurrent-use')
                finally:
                    stream._lock.release()
                self.assertFalse(hasattr(stream, 'fileno'))
                stream.close()
                peer.wait_closed()
            self.assertEqual(captured.getvalue(), '')
            self.assertEqual(before, set(WORKER.parent.iterdir()))
        PROOF.append({'scenario': 'silent-diagnostics', 'result': 'pass', 'diagnosticBytes': 0,
                      'createdKeyOrLogFiles': 0, 'duplicateHandleUnavailable': True, 'concurrentUseRefused': True})


if __name__ == '__main__':
    try:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(ServiceProof)
        result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2).run(suite)
        print(json.dumps({'boundary': 'actual host opener on disposable usbmuxd/lockdown/TLS peers; not an iPhone',
                          'openssl': ssl.OPENSSL_VERSION, 'cases': PROOF, 'passed': result.wasSuccessful()}, indent=2))
        sys.exit(0 if result.wasSuccessful() else 1)
    finally:
        ROOT.cleanup()
