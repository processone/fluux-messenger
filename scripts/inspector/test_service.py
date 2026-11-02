"""FLM-366 owns the opener boundary; peers are disposable, never an iPhone.

Exercises the actual C implementation, OpenSSL, Unix sockets and unchanged Reader.
Pair records/certificates below are generated for this run, not personal fixtures.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import signal
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


def plist_packet(value):
    body = plistlib.dumps(value, fmt=plistlib.FMT_BINARY)
    return struct.pack('>I', len(body)) + body


def send_plist(sock, value):
    sock.sendall(plist_packet(value))


class StopAfterSample:
    """End a positive journey only after an actual sanitized record is persisted."""
    def __init__(self, file, stop):
        self.file, self.stop = file, stop

    def flush(self):
        self.file.flush()
        self.stop.set()

    def __getattr__(self, name):
        return getattr(self.file, name)


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
        self.plain = mode in ('plain', 'plain-backpressure')
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
        self.service_digest = hashlib.sha256()
        self.expected_bytes = 0
        self.drained = threading.Event()
        self.expressions = []
        self.sample_requested = threading.Event()
        self.sample_reply = threading.Event()
        self.on_sample = None
        self.late_reply_sent = False
        self.timers = []
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
                                      'EnableServiceSSL': not self.plain})
                    p = read_plist(conn)
                    self.requests.append(p['Request'])
                    assert p['Request'] == 'StopSession'
                    send_plist(conn, {'Request': 'StopSession'})
                else:
                    if self.mode == 'tls-partial':
                        conn = FragmentedTLS(conn, self.context, self.fragment_cut, self.release)
                    elif not self.plain:
                        conn = self.context.wrap_socket(conn, server_side=True)
                    self.service_ready.set()
                    if self.mode.startswith('inspector'):
                        self.inspector(conn)
                    elif self.mode == 'flood':
                        while True:
                            conn.sendall(b'x' * 65536)
                    elif self.mode == 'blocked-write':
                        self.release.wait(3)
                    elif self.mode in ('backpressure', 'plain-backpressure'):
                        assert self.release.wait(2)
                        while self.service_bytes < self.expected_bytes:
                            data = conn.recv(65536)
                            if not data:
                                break
                            self.service_bytes += len(data)
                            self.service_digest.update(data)
                        self.drained.set()
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
                self.expressions.append('present' if exp == PRESENT else 'install' if exp == SAMPLER
                                        else 'sample' if exp == SAMPLE else 'remove')
                if exp == SAMPLE and not self.sample_requested.is_set():
                    if self.on_sample:
                        self.on_sample()
                    self.sample_requested.set()
                value = False if exp == PRESENT else SAMPLES[0] if exp == SAMPLE else True
                message = {'id': command['id'], 'result': {'result': {'value': value}}}
                def response(message=message):
                    event('_rpc_applicationSentData:', {'WIRApplicationIdentifierKey': 'PID:321',
                        'WIRDestinationKey': sender, 'WIRMessageDataKey': json.dumps(message)})
                if exp == SAMPLE:
                    if self.mode == 'inspector-disconnect':
                        return
                    if self.mode in ('inspector-frozen', 'inspector-interrupt'):
                        continue
                    if self.mode == 'inspector-partial-sample':
                        packet = plist_packet({'__selector': '_rpc_applicationSentData:', '__argument': {
                            'WIRApplicationIdentifierKey': 'PID:321', 'WIRDestinationKey': sender,
                            'WIRMessageDataKey': json.dumps(message)}})
                        conn.sendall(packet[:6])  # Prefix and a partial body, then silence.
                        continue
                    if self.mode == 'inspector-delayed':
                        def late_response(response=response):
                            try:
                                response()
                                self.late_reply_sent = True
                            except OSError:
                                pass
                            finally:
                                self.sample_reply.set()
                        timer = threading.Timer(.08, late_response)
                        self.timers.append(timer)
                        timer.start()
                        continue
                    if self.mode == 'inspector-error':
                        message = {'id': command['id'], 'error': {'message': PRIVATE}}
                        event('_rpc_applicationSentData:', {'WIRApplicationIdentifierKey': 'PID:321',
                            'WIRDestinationKey': sender, 'WIRMessageDataKey': json.dumps(message)})
                        continue
                if exp == REMOVE:
                    if self.mode in ('inspector-frozen', 'inspector-interrupt', 'inspector-partial-sample'):
                        continue
                    if self.mode == 'inspector-delayed':
                        assert self.sample_reply.wait(1)
                response()
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
        for timer in self.timers:
            timer.cancel()
            timer.join(2)
            assert not timer.is_alive(), 'peer-timer-not-closed'
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
            # FLM-369 W4: a deadline may cut an in-flight sample frame, where
            # unconfirmed cleanup is correct. The positive confirmation journey
            # instead stops after a complete persisted sample; deadline cuts have
            # their own adverse cases below, not a longer timing guess here.
            stop = threading.Event()
            result = reader.run(StopAfterSample(output, stop), stop=stop, duration=2)
            output.seek(0)
            saved = output.read()
            self.assertNotIn(PRIVATE.encode(), saved)
            records = [json.loads(line) for line in saved.splitlines()]
            PROOF.append({'scenario': 'reader-stream', 'reader': result, 'persistedRecords': records,
                          'readDesynchronized': reader.read_desynchronized,
                          'expressions': peer.expressions, 'selectors': peer.requests,
                          'workerReaped': stream._process.poll() is not None})
            self.assertEqual(result['reason'], 'stopped')
            self.assertEqual(result['cleanup'], 'confirmed')
            self.assertEqual(result['samples'], 1)
            self.assertEqual(records[0]['mountedRows'], SAMPLES[0]['mountedRows'])
            self.assertIsNotNone(stream._process.poll())
            peer.wait_closed()
            self.assertIn('_rpc_forwardDidClose:', peer.requests)

    def test_reader_deadline_cleanup(self):
        # FLM-369 E1/W4: exercise the final shrinking timeout through the real
        # opener, not only the healthy peer or the reader's socket-only fixture.
        for mode in ('inspector-frozen', 'inspector-delayed', 'inspector-partial-sample'):
            with self.subTest(mode=mode), DevicePeer(mode) as peer, tempfile.TemporaryFile('w+b', dir=WORKER.parent) as output:
                budget = Budget()
                stream = self.open(peer, budget)
                reader = Reader(stream, budget)
                # Start a short real deadline only after acknowledged installation.
                peer.on_sample = lambda: setattr(reader, 'deadline', time.monotonic() + .04)
                result = reader.run(output, duration=2)
                PROOF.append({'scenario': 'native-edge-journeys', 'case': mode, 'reader': result,
                              'expressions': peer.expressions, 'selectors': peer.requests,
                              'lateSampleDelivered': peer.late_reply_sent,
                              'readDesynchronized': reader.read_desynchronized,
                              'workerReaped': stream._process.poll() is not None})
                self.assertEqual(result['reason'], 'time-limit')
                self.assertEqual(result['cleanup'], 'confirmed' if mode == 'inspector-delayed' else 'unconfirmed')
                self.assertEqual(reader.read_desynchronized, mode == 'inspector-partial-sample')
                peer.wait_closed()
                self.assertIn('remove', peer.expressions)
                self.assertIn('_rpc_forwardDidClose:', peer.requests)
                if mode == 'inspector-delayed':
                    self.assertTrue(peer.late_reply_sent)
                self.assertIsNotNone(stream._process.poll())

    def test_reader_disconnect_and_private_error(self):
        # FLM-369 W4. W3's disconnect category is intentionally unchanged.
        for mode in ('inspector-disconnect', 'inspector-error'):
            with self.subTest(mode=mode), DevicePeer(mode) as peer, tempfile.TemporaryFile('w+b', dir=WORKER.parent) as output:
                budget = Budget()
                stream = self.open(peer, budget)
                result = Reader(stream, budget).run(output, duration=2)
                self.assertEqual(result['reason'], 'protocol-boundary' if mode == 'inspector-disconnect' else 'evaluation-failed')
                self.assertEqual(result['cleanup'], 'unconfirmed' if mode == 'inspector-disconnect' else 'confirmed')
                output.seek(0)
                self.assertNotIn(PRIVATE.encode(), output.read())
                peer.wait_closed()
                self.assertIsNotNone(stream._process.poll())
                if mode == 'inspector-error':
                    self.assertIn('remove', peer.expressions)
                    self.assertIn('_rpc_forwardDidClose:', peer.requests)
                PROOF.append({'scenario': 'native-edge-journeys', 'case': mode, 'reader': result,
                              'expressions': peer.expressions, 'selectors': peer.requests,
                              'unchangedPolicy': 'W3' if mode == 'inspector-disconnect' else None, 'workerReaped': True})

    def test_reader_in_exchange_interrupt(self):
        # FLM-369 W4 and captain-selected W2: a half-finished exchange still
        # fails closed. Group isolation is proved separately, without weakening
        # that boundary. Raise a real SIGINT inside a control transaction.
        with DevicePeer('inspector-interrupt') as peer, tempfile.TemporaryFile('w+b', dir=WORKER.parent) as output:
            budget = Budget()
            stream = self.open(peer, budget)
            reader = Reader(stream, budget)
            read = stream._read_exact
            interrupted = False
            def interrupt_response(n):
                nonlocal interrupted
                if peer.sample_requested.is_set() and not interrupted:
                    interrupted = True
                    signal.raise_signal(signal.SIGINT)
                return read(n)
            stream._read_exact = interrupt_response
            with self.assertRaises(KeyboardInterrupt):
                reader.run(output, duration=2)
            self.assertTrue(interrupted)
            self.assertEqual(reader.result['reason'], 'stopped')
            self.assertEqual(reader.result['cleanup'], 'unconfirmed')
            self.assertTrue(stream.closed)
            self.assertIsNotNone(stream._process.poll())
            peer.wait_closed()
            PROOF.append({'scenario': 'native-edge-journeys', 'case': 'inspector-interrupt',
                          'reader': reader.result, 'expressions': peer.expressions, 'selectors': peer.requests,
                          'selectedPolicy': 'W2: mid-exchange signal still fails closed', 'workerReaped': True})

    def test_worker_survives_caller_group_sigint(self):
        # Captain-selected W2 group-only: signal only this disposable helper's
        # new group, never the test runner, another task or a real application.
        code = '''
import os, signal, socket, sys, time
sys.path.insert(0, sys.argv[1])
from reader import Budget
from service import open_service
bridge = socket.socket(fileno=int(sys.argv[5]))
# A Python signal handler must not acquire Event.wait's condition lock.
# The runtime writes one signal byte to this nonblocking wakeup descriptor.
wakeup, writer = socket.socketpair()
writer.setblocking(False)
wakeup.settimeout(1)
signal.set_wakeup_fd(writer.fileno())
signal.signal(signal.SIGINT, lambda *_: None)
with open_service(sys.argv[2], sys.argv[3], Budget(), mux_socket=sys.argv[4], lifetime=2) as stream:
    bridge.sendall(b'R')
    assert wakeup.recv(1) == bytes([signal.SIGINT])
    assert stream._process.poll() is None
    payload = b'after-group-sigint'
    assert stream.send(payload) == len(payload)
    received = b''
    deadline = time.monotonic()+1
    while len(received) < len(payload):
        assert time.monotonic() < deadline
        try:
            received += stream.recv(len(payload)-len(received))
        except socket.timeout:
            pass
    assert received == payload
bridge.sendall(b'O')
signal.set_wakeup_fd(-1)
wakeup.close(); writer.close(); bridge.close()
'''
        with DevicePeer() as peer:
            parent, child = socket.socketpair()
            parent.settimeout(3)
            process = subprocess.Popen([sys.executable, '-B', '-c', code, str(Path(__file__).parent),
                                        str(WORKER), UDID, peer.path, str(child.fileno())],
                                       pass_fds=(child.fileno(),), start_new_session=True,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            child.close()
            try:
                self.assertEqual(parent.recv(1), b'R')
                os.killpg(process.pid, signal.SIGINT)
                self.assertEqual(parent.recv(1), b'O')
                stdout, stderr = process.communicate(timeout=3)
                self.assertEqual(process.returncode, 0, 'group-signal-child-failed')
                self.assertEqual((stdout, stderr), (b'', b''))
            finally:
                parent.close()
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=3)
            peer.wait_closed()
        PROOF.append({'scenario': 'native-edge-journeys', 'case': 'caller-group-sigint',
                      'workerSurvivedSignal': True, 'byteExchangeAfterSignal': True,
                      'helperAndWorkerReaped': True})

    def test_transient_backpressure(self):
        # FLM-369 W1: bytes must survive both native send EAGAIN and SSL WANT_WRITE.
        chunk = bytes(range(256)) * 256
        for mode in ('backpressure', 'plain-backpressure'):
            with self.subTest(mode=mode), DevicePeer(mode) as peer:
                peer.expected_bytes = len(chunk) * 16
                stream = self.open(peer)
                released_at = []
                def release_reads():
                    released_at.append(time.monotonic())
                    peer.release.set()
                # Controlled peer input pause, not a test retry/stabilization wait.
                timer = threading.Timer(.03, release_reads)
                spans = []
                timer.start()
                try:
                    for _ in range(16):
                        start = time.monotonic()
                        self.assertEqual(stream.send(chunk), len(chunk))
                        spans.append((start, time.monotonic()))
                    self.assertTrue(peer.drained.wait(2))
                finally:
                    peer.release.set()
                    timer.cancel()
                    timer.join(2)
                    stream.close()
                peer.wait_closed()
                self.assertTrue(released_at)
                self.assertTrue(any(start <= released_at[0] <= end for start, end in spans))
                expected = hashlib.sha256(chunk * 16).hexdigest()
                self.assertEqual(peer.service_bytes, peer.expected_bytes)
                self.assertEqual(peer.service_digest.hexdigest(), expected)
                PROOF.append({'scenario': 'native-edge-journeys', 'case': mode,
                              'receivedBytes': peer.service_bytes, 'receivedSha256': peer.service_digest.hexdigest(),
                              'expectedSha256': expected, 'writeSpannedPeerRelease': True,
                              'longestWriteSeconds': round(max(end-start for start, end in spans), 4),
                              'workerReaped': stream._process.poll() is not None})

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

    def test_qualified_budget_failure_is_preserved(self):
        # FLM-369 I1: the producer must not depend on its consumer's top-level
        # module name. Exercise the actual Budget source under a qualified name.
        spec = importlib.util.spec_from_file_location('qualified_inspector.reader',
                                                      Path(__file__).with_name('reader.py'))
        qualified = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(qualified)
        with DevicePeer('flood') as peer:
            budget = qualified.Budget(START_CREDIT + 65536)
            stream = self.open(peer, budget)
            budget.charge(budget.limit - budget.input - budget.output)
            with self.assertRaises(qualified.Boundary) as caught:
                while True:
                    try:
                        stream.recv(65536)
                    except socket.timeout:
                        continue
            self.assertIs(type(caught.exception), qualified.Boundary)
            self.assertEqual(caught.exception.args, ('byte-limit',))
            self.assertTrue(stream.closed)
            self.assertFalse(stream._lock.locked())
            self.assertIsNotNone(stream._process.poll())
            peer.wait_closed()
            PROOF.append({'scenario': 'shared-budget', 'case': 'qualified-budget-exception',
                          'originalExceptionTypePreserved': True, 'category': caught.exception.args[0],
                          'chargedBytes': budget.input + budget.output, 'limitBytes': budget.limit,
                          'adapterLockReleased': True, 'workerReaped': True})

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
