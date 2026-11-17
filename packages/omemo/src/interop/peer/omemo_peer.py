#!/usr/bin/env python3
# Reference OMEMO 2 peer using python-omemo (PyPI package name: `OMEMO`, MIT) plus the
# `twomemo` backend (the `urn:xmpp:omemo:2` implementation, MIT). This is the Syndace
# reference stack; reading its *public API docs* is expected and allowed for this harness.
#
# The peer performs a crypto round-trip over plain files under /shared -- no live XMPP
# server is involved. Our @fluux/omemo wire format IS XEP-0384/OMEMO 2, so the natural
# bridge between our JSON blobs and python-omemo's `Message` objects is the XEP-0384
# `<encrypted>` / `<bundle>` XML that twomemo already knows how to serialize/parse via
# `twomemo.etree`. We build that XML from our JSON and hand it to the library.
#
# Usage:
#   python omemo_peer.py gen-bundle
#   python omemo_peer.py decrypt  <msg.json>
#   python omemo_peer.py encrypt  <ourbundle.json> <text>
#
# ---------------------------------------------------------------------------------------
# SCOPE (read the sibling README.md): this validates the CRYPTO-TRANSPORT layers only --
# X3DH session establishment from our bundle, the Double Ratchet, the OMEMOKeyExchange /
# OMEMOAuthenticatedMessage / OMEMOMessage protobuf wire format, the 48-byte
# `key || auth_tag` payload-key transport, and the AES-256-CBC ("OMEMO Payload") cipher.
# It does NOT validate XEP-0420 <envelope> XML: @fluux/omemo is content-agnostic and transports
# the caller's opaque `content` bytes verbatim (no envelope wrapping). `decrypt` therefore
# recovers and writes the RAW payload plaintext bytes it obtained; interpreting those bytes as a
# message body is the caller's job (the TS test asserts they equal our content). See README.md.
# ---------------------------------------------------------------------------------------

import sys
import json
import base64
import asyncio
import xml.etree.ElementTree as ET
from typing import Dict, FrozenSet, Optional, Tuple

# python-omemo (package `OMEMO`) public API.
from omemo import (
    SessionManager,
    Message,
    Storage,
    Maybe,
    Just,
    Nothing,
    Bundle,
    DeviceInformation,
    TrustLevel,
    JSONType,
)

# twomemo: the `urn:xmpp:omemo:2` backend + its XEP-0384 XML (de)serializers.
import twomemo
from twomemo import NAMESPACE  # "urn:xmpp:omemo:2"
from twomemo.etree import serialize_bundle, parse_message, serialize_message

SHARED = "/shared"
STORAGE_PATH = f"{SHARED}/peer_storage.json"

PEER_JID = "peer@local"   # this reference peer
ALICE_JID = "alice@local"  # the @fluux/omemo side (message sender / bundle owner)
NS = f"{{{NAMESPACE}}}"

# The custom trust level name we initialise devices with, mapped to TRUSTED below so the
# harness never blocks on a trust decision.
TRUST_LEVEL_NAME = "trusted"


# --------------------------------------------------------------------------------------
# A trivial JSON-file-backed Storage. python-omemo persists *all* its state (identity,
# signed pre key, one-time pre keys, ratchet sessions, ...) through this key/value store.
# gen-bundle creates it; decrypt/encrypt reload it so the peer keeps a stable identity.
# --------------------------------------------------------------------------------------
class FileStorage(Storage):
    def __init__(self, path: str) -> None:
        super().__init__()
        self._path = path
        try:
            with open(path, "r", encoding="utf8") as fh:
                self._data: Dict[str, JSONType] = json.load(fh)
        except FileNotFoundError:
            self._data = {}

    def _flush(self) -> None:
        with open(self._path, "w", encoding="utf8") as fh:
            json.dump(self._data, fh)

    async def _load(self, key: str) -> Maybe[JSONType]:
        if key in self._data:
            return Just(self._data[key])
        return Nothing()

    async def _store(self, key: str, value: JSONType) -> None:
        self._data[key] = value
        self._flush()

    async def _delete(self, key: str) -> None:
        self._data.pop(key, None)
        self._flush()


# --------------------------------------------------------------------------------------
# SessionManager with file-backed network stubs. python-omemo drives PEP bundle/device-list
# publishing and message sending through these abstract methods; the harness has no XMPP
# server, so we back them with /shared files and permissive trust.
#
# INTEGRATION POINT (unverifiable here without a docker run): the exact set of network
# callbacks SessionManager.decrypt() invokes for the *sender* (alice@local) is version
# dependent. For a first-contact OMEMOKeyExchange message the sender's identity key is
# embedded in the key exchange itself, so a passive session can be built without fetching
# alice's bundle. We stub `_download_device_list` to advertise the sender's device and
# `_download_bundle` to raise BundleNotFound; if a given python-omemo build additionally
# insists on the sender bundle to cross-check the IK, feed alice's bundle.json through
# `twomemo.etree.parse_bundle` here. This is the one call whose precise trigger set cannot
# be confirmed without executing the container (see README.md).
# --------------------------------------------------------------------------------------
class FilePeer(SessionManager):
    # captured during create()/publish so gen-bundle can emit our JSON contract.
    published_bundle: Optional[Bundle] = None

    @staticmethod
    async def _upload_bundle(bundle: Bundle) -> None:
        FilePeer.published_bundle = bundle

    @staticmethod
    async def _download_bundle(namespace: str, bare_jid: str, device_id: int) -> Bundle:
        from omemo import BundleDownloadFailed
        raise BundleDownloadFailed(f"no network bundle for {bare_jid}/{device_id}")

    @staticmethod
    async def _delete_bundle(namespace: str, device_id: int) -> None:
        return None

    @staticmethod
    async def _upload_device_list(namespace: str, device_list: Dict[int, Optional[str]]) -> None:
        return None

    @staticmethod
    async def _download_device_list(namespace: str, bare_jid: str) -> Dict[int, Optional[str]]:
        # Advertise whatever device the message references so the sender is "known".
        # The concrete device id is filled in by decrypt() via a module-global.
        return dict(_ADVERTISED_DEVICES)

    async def _evaluate_custom_trust_level(self, device: DeviceInformation) -> TrustLevel:
        return TrustLevel.TRUSTED

    async def _make_trust_decision(
        self,
        undecided: FrozenSet[DeviceInformation],
        identifier: Optional[str],
    ) -> None:
        # Auto-trust every device so the round-trip never blocks on a manual decision.
        for dev in undecided:
            await self.set_trust(dev.bare_jid, dev.identity_key, TrustLevel.TRUSTED.name)

    @staticmethod
    async def _send_message(message: Message, bare_jid: str) -> None:
        # python-omemo may emit an "empty" message to confirm a freshly built passive
        # session. No XMPP transport here -> no-op.
        return None


# Populated by decrypt() before SessionManager.decrypt so `_download_device_list` can
# advertise the sender's device id.
_ADVERTISED_DEVICES: Dict[int, Optional[str]] = {}


async def _make_manager() -> FilePeer:
    storage = FileStorage(STORAGE_PATH)
    return await FilePeer.create(
        backends=[twomemo.Twomemo(storage)],
        storage=storage,
        own_bare_jid=PEER_JID,
        initial_own_label=None,
        undecided_trust_level_name=TRUST_LEVEL_NAME,
    )


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ASCII")


# --------------------------------------------------------------------------------------
# Command: gen-bundle
# Emits our JSON bundle contract (base64 fields) from the peer's freshly published bundle.
# --------------------------------------------------------------------------------------
async def gen_bundle() -> None:
    manager = await _make_manager()
    own_info, _ = await manager.get_own_device_information()
    device_id = own_info.device_id

    bundle = FilePeer.published_bundle
    if bundle is None:
        # Reloaded storage (bundle already published earlier); serialize the current one.
        # `serialize_bundle` needs a BundleImpl; obtain it from the backend.
        # INTEGRATION POINT: on a reload path fetch the current bundle from the backend
        # (e.g. via the backend's get_bundle) instead of the create()-time capture.
        raise RuntimeError("run gen-bundle against a fresh /shared (delete peer_storage.json first)")

    xml = serialize_bundle(bundle)  # XEP-0384 <bundle> element (twomemo BundleImpl)

    def text(tag: str) -> str:
        el = xml.find(f"{NS}{tag}")
        assert el is not None and el.text is not None
        return el.text

    spk_el = xml.find(f"{NS}spk")
    assert spk_el is not None and spk_el.text is not None
    prekeys = []
    prekeys_el = xml.find(f"{NS}prekeys")
    assert prekeys_el is not None
    for pk in prekeys_el.iter(f"{NS}pk"):
        assert pk.text is not None
        prekeys.append({"id": int(pk.get("id")), "key": pk.text})

    out = {
        "deviceId": device_id,
        "ik": text("ik"),                       # Ed25519 identity public key (32 bytes)
        "spkId": int(spk_el.get("id")),
        "spk": spk_el.text,                     # X25519 signed pre key public (32 bytes)
        "spkSig": text("spks"),                 # Ed25519 signature over spk (64 bytes)
        "preKeys": prekeys,                     # [{ id, key(b64) }]
    }
    with open(f"{SHARED}/bundle.json", "w", encoding="utf8") as fh:
        json.dump(out, fh)


# --------------------------------------------------------------------------------------
# Command: decrypt <msg.json>
# Reads our OmemoMessage JSON, rebuilds the XEP-0384 <encrypted> XML, parses it into a
# python-omemo Message, and decrypts. Writes the RAW recovered payload plaintext (base64)
# to /shared/plaintext.b64 -- NOT a parsed body (see SCOPE note at the top).
# --------------------------------------------------------------------------------------
def _msg_json_to_xml(msg: dict) -> ET.Element:
    # msg = { sid, payload(b64|None), keys: [{ rid, kex(bool), data(b64) }] }
    encrypted = ET.Element(f"{NS}encrypted")
    header = ET.SubElement(encrypted, f"{NS}header", attrib={"sid": str(msg["sid"])})
    # All keys are addressed to this reference peer (PEER_JID).
    keys_el = ET.SubElement(header, f"{NS}keys", attrib={"jid": PEER_JID})
    for k in msg["keys"]:
        attrib = {"rid": str(k["rid"])}
        if k.get("kex"):
            attrib["kex"] = "true"
        ET.SubElement(keys_el, f"{NS}key", attrib=attrib).text = k["data"]
    if msg.get("payload"):
        ET.SubElement(encrypted, f"{NS}payload").text = msg["payload"]
    return encrypted


async def decrypt(msg_path: str) -> None:
    global _ADVERTISED_DEVICES
    with open(msg_path, "r", encoding="utf8") as fh:
        msg = json.load(fh)

    # Advertise the sender's device so trust/consistency lookups resolve.
    _ADVERTISED_DEVICES = {int(msg["sid"]): None}

    manager = await _make_manager()
    xml = _msg_json_to_xml(msg)
    message = parse_message(xml, ALICE_JID)  # sender bare JID = the @fluux/omemo side

    plaintext, _device, _key_material = await manager.decrypt(message)

    # plaintext is the RAW payload bytes recovered by the reference (our opaque content
    # bytes), or None for an empty/key-transport message.
    with open(f"{SHARED}/plaintext.b64", "w", encoding="utf8") as fh:
        fh.write("" if plaintext is None else _b64(plaintext))


# --------------------------------------------------------------------------------------
# Command: encrypt <ourbundle.json> <text>
# Encrypts <text> to OUR bundle and writes an OmemoMessage JSON to /shared/msg_from_peer.json.
# The reverse-direction round-trip is subject to the same envelope-scope limit: <text> is
# encrypted as raw payload bytes, so a body-level TS assertion would require our SCE format.
# --------------------------------------------------------------------------------------
async def encrypt(bundle_path: str, text: str) -> None:
    with open(bundle_path, "r", encoding="utf8") as fh:
        ours = json.load(fh)

    # INTEGRATION POINT: to encrypt to alice we must register her bundle/device list with
    # the manager. Build a XEP-0384 <bundle> element from `ours` and feed it through
    # `twomemo.etree.parse_bundle(elt, ALICE_JID, ours["deviceId"])`, then surface it from
    # `_download_bundle`/`_download_device_list` for ALICE_JID. Exact wiring depends on the
    # installed python-omemo version's caching of downloaded bundles; confirm on a real run.
    manager = await _make_manager()
    messages, _errors = await manager.encrypt(
        bare_jids=frozenset([ALICE_JID]),
        plaintext={NAMESPACE: text.encode("utf8")},
    )
    message = next(iter(messages.keys()))
    xml = serialize_message(message)

    header = xml.find(f"{NS}header")
    assert header is not None
    keys_out = []
    for keys_el in header.iter(f"{NS}keys"):
        for key_el in keys_el.iter(f"{NS}key"):
            assert key_el.text is not None
            keys_out.append({
                "rid": int(key_el.get("rid")),
                "kex": key_el.get("kex", "false") in ("true", "1"),
                "data": key_el.text,
            })
    payload_el = xml.find(f"{NS}payload")
    out = {
        "sid": int(header.get("sid")),
        "payload": payload_el.text if payload_el is not None else None,
        "keys": keys_out,
    }
    with open(f"{SHARED}/msg_from_peer.json", "w", encoding="utf8") as fh:
        json.dump(out, fh)


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: omemo_peer.py (gen-bundle | decrypt <msg.json> | encrypt <bundle.json> <text>)")
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "gen-bundle":
        asyncio.run(gen_bundle())
    elif cmd == "decrypt":
        asyncio.run(decrypt(sys.argv[2]))
    elif cmd == "encrypt":
        asyncio.run(encrypt(sys.argv[2], sys.argv[3]))
    else:
        print(f"unknown command: {cmd}")
        sys.exit(2)


if __name__ == "__main__":
    main()
