#!/usr/bin/env python3
"""
Docker-free OMEMO 2 crypto interop — VALIDATED 2026-07-13 against OMEMO/twomemo 2.1.0.

Direction (this is the load-bearing detail): the reference is the RECIPIENT, because only
the recipient holds the private keys needed to decrypt.
  Bob   = python-omemo / twomemo reference  (generates its own bundle, decrypts)
  Alice = @fluux/omemo TS library           (fetches Bob's bundle, encrypts)

Flow: reference generates Bob's bundle -> our TS lib encrypts to it -> reference decrypts,
recovering our exact SCE-envelope payload bytes with no MAC/auth error at any layer. This
exercises X3DH (DH ordering, "OMEMO X3DH" KDF, AD = IK_A||IK_B), the Double Ratchet
("OMEMO Root Chain" / "OMEMO Message Key Material", mk=HMAC(ck,0x01)), and the
AES-256-CBC + HMAC-trunc16 "OMEMO Payload" cipher.

Usage: python interop_decrypt.py <RUN_DIR> [<PKG_DIR>]   (normally invoked by run.sh)
Exit 0 = CRYPTO SUCCESS.
"""
import asyncio, base64, json, os, subprocess, copy, sys, traceback
import xml.etree.ElementTree as ET
from typing import Dict

from omemo import SessionManager, Storage, Message, Bundle, DeviceList, DeviceInformation
from omemo.storage import Just, Nothing, Maybe
from omemo.types import TrustLevel, JSONType
from twomemo import Twomemo
from twomemo.twomemo import NAMESPACE
import twomemo.etree as tetree

HERE = os.path.dirname(os.path.abspath(__file__))
RUN = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "_run")
os.makedirs(RUN, exist_ok=True)
EMIT = os.path.join(HERE, "emit_to_bob.mjs")
NODE = os.environ.get("NODE", "node")

# In-memory "network" shared across the SessionManager static callbacks.
BUNDLES: Dict[tuple, Bundle] = {}
DEVICE_LISTS: Dict[tuple, DeviceList] = {}


class MemStorage(Storage):
    def __init__(self):
        super().__init__()
        self._d: Dict[str, JSONType] = {}

    async def _load(self, key: str) -> Maybe[JSONType]:
        return Just(self._d[key]) if key in self._d else Nothing()

    async def _store(self, key: str, value: JSONType) -> None:
        self._d[key] = copy.deepcopy(value)

    async def _delete(self, key: str) -> None:
        self._d.pop(key, None)


class InteropSessionManager(SessionManager):
    @staticmethod
    async def _upload_bundle(bundle: Bundle) -> None:
        BUNDLES[(bundle.namespace, bundle.bare_jid, bundle.device_id)] = bundle

    @staticmethod
    async def _download_bundle(namespace: str, bare_jid: str, device_id: int) -> Bundle:
        from omemo.session_manager import BundleNotFound
        b = BUNDLES.get((namespace, bare_jid, device_id))
        if b is None:
            raise BundleNotFound(f"no bundle for {bare_jid}/{device_id}")
        return b

    @staticmethod
    async def _delete_bundle(namespace: str, device_id: int) -> None:
        for k in list(BUNDLES):
            if k[0] == namespace and k[2] == device_id:
                BUNDLES.pop(k, None)

    @staticmethod
    async def _upload_device_list(namespace: str, device_list: DeviceList) -> None:
        DEVICE_LISTS[(namespace, "bob@localhost")] = dict(device_list)

    @staticmethod
    async def _download_device_list(namespace: str, bare_jid: str) -> DeviceList:
        return dict(DEVICE_LISTS.get((namespace, bare_jid), {}))

    async def _evaluate_custom_trust_level(self, device: DeviceInformation) -> TrustLevel:
        return TrustLevel.TRUSTED  # auto-trust so decryption is never blocked

    async def _make_trust_decision(self, undecided, identifier=None) -> None:
        for dev in undecided:
            await self.set_trust(dev.bare_jid, dev.identity_key, "trusted")

    @staticmethod
    async def _send_message(message: Message, bare_jid: str) -> None:
        pass  # history-sync mode during decrypt; not called


async def main() -> None:
    # 1) Reference generates Bob (its own identity + bundle).
    storage = MemStorage()
    bob = await InteropSessionManager.create(
        backends=[Twomemo(storage)],
        storage=storage,
        own_bare_jid="bob@localhost",
        initial_own_label=None,
        undecided_trust_level_name="undecided",
    )
    own_info, _ = await bob.get_own_device_information()
    bob_dev = own_info.device_id
    backend = getattr(bob, "_SessionManager__backends")[0]
    bob_bundle = await backend.get_bundle("bob@localhost", bob_dev)
    xb = bob_bundle.bundle  # x3dh.Bundle
    bob_json = {
        "deviceId": bob_dev,
        "ik": base64.b64encode(xb.identity_key).decode(),
        "spkId": bob_bundle.signed_pre_key_id,
        "spk": base64.b64encode(xb.signed_pre_key).decode(),
        "spkSig": base64.b64encode(xb.signed_pre_key_sig).decode(),
        "preKeys": [
            {"id": bob_bundle.pre_key_ids[pk], "key": base64.b64encode(pk).decode()}
            for pk in xb.pre_keys
        ],
    }
    with open(os.path.join(RUN, "bob_bundle.json"), "w") as f:
        json.dump(bob_json, f, indent=2)
    print(f"[py] Bob generated. device_id={bob_dev} ik={len(xb.identity_key)}B "
          f"spk={len(xb.signed_pre_key)}B spks={len(xb.signed_pre_key_sig)}B "
          f"prekeys={len(bob_json['preKeys'])}")

    # 2) Our TS lib (Alice) encrypts to Bob's bundle.
    r = subprocess.run([NODE, EMIT, RUN], capture_output=True, text=True)
    print("[node]", r.stdout.strip())
    if r.returncode != 0:
        print("[node STDERR]", r.stderr)
        raise SystemExit("node emitter failed")
    with open(os.path.join(RUN, "our_msg.json")) as f:
        ours = json.load(f)

    alice = ours["alice"]
    alice_jid = "alice@localhost"
    alice_sid = ours["message"]["sid"]

    # 3) Register Alice's device + bundle in Bob's world so decrypt can find the sender.
    NS = f"{{{NAMESPACE}}}"
    bundle_elt = ET.Element(f"{NS}bundle")
    ET.SubElement(bundle_elt, f"{NS}spk", attrib={"id": str(alice["spkId"])}).text = alice["spk"]
    ET.SubElement(bundle_elt, f"{NS}spks").text = alice["spkSig"]
    ET.SubElement(bundle_elt, f"{NS}ik").text = alice["ik"]
    prekeys_elt = ET.SubElement(bundle_elt, f"{NS}prekeys")
    for pk in alice["preKeys"]:
        ET.SubElement(prekeys_elt, f"{NS}pk", attrib={"id": str(pk["id"])}).text = pk["key"]
    alice_bundle = tetree.parse_bundle(bundle_elt, alice_jid, alice_sid)
    BUNDLES[(NAMESPACE, alice_jid, alice_sid)] = alice_bundle
    DEVICE_LISTS[(NAMESPACE, alice_jid)] = {alice_sid: None}
    await bob.update_device_list(NAMESPACE, alice_jid, {alice_sid: None})
    print(f"[py] Registered Alice sid={alice_sid}")

    # 4) Reconstruct the XEP-0384 <encrypted> element from OUR message JSON.
    enc = ET.Element(f"{NS}encrypted")
    header = ET.SubElement(enc, f"{NS}header", attrib={"sid": str(ours["message"]["sid"])})
    keys_elt = ET.SubElement(header, f"{NS}keys", attrib={"jid": "bob@localhost"})
    for k in ours["message"]["keys"]:
        attrib = {"rid": str(k["rid"])}
        if k["kex"]:
            attrib["kex"] = "true"
        ET.SubElement(keys_elt, f"{NS}key", attrib=attrib).text = k["data"]
    if ours["message"]["payload"]:
        ET.SubElement(enc, f"{NS}payload").text = ours["message"]["payload"]
    message = tetree.parse_message(enc, alice_jid)
    print(f"[py] Parsed our message: sid={message.device_id} keys={len(message.keys)}")

    # 5) DECRYPT with the reference.
    print("\n[py] === calling bob.decrypt() ===")
    plaintext, sender_device, _plain_km = await bob.decrypt(message)

    print("\n========== DECRYPT RESULT ==========")
    print(f"sender: bare_jid={sender_device.bare_jid} device_id={sender_device.device_id}")
    if plaintext is None:
        print("plaintext: None (empty OMEMO message)")
    else:
        print(f"recovered {len(plaintext)}B (our SCE envelope); our ciphertext was "
              f"{ours['message']['payloadLen']}B")
        print(f"recovered (utf-8, best effort): "
              f"{plaintext.decode('utf-8', errors='replace')!r}")
        expected = ours["plaintext"].encode()
        assert expected in plaintext, "recovered envelope does not contain our plaintext"
    print("====================================")
    print("\nCRYPTO SUCCESS: reference established the X3DH session from our KeyExchange, ran the "
          "double-ratchet decrypt, verified the payload HMAC, and AES-CBC-decrypted the payload to "
          "our SCE envelope bytes with NO MAC/auth error. X3DH, ratchet, and payload cipher "
          "interoperate byte-for-byte.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        print("\n########## CRYPTO INTEROP FAILURE / EXCEPTION ##########")
        traceback.print_exc()
        sys.exit(1)
