#!/usr/bin/env python3
"""
Process 2 of the plugin body-level interop gate. Reads the plugin-produced
`plugin_msg.json` (a serialized `<encrypted xmlns='urn:xmpp:omemo:2'>` stanza +
the sender's bundle), RELOADS Bob's persisted storage, decrypts the stanza with
the twomemo reference, and — crucially — parses the recovered opaque bytes as a
XEP-0420 `<envelope xmlns='urn:xmpp:sce:1'>` and prints the recovered `<body>`.

twomemo/python-omemo returns the recovered SCE envelope as OPAQUE BYTES; it does
NOT itself parse XEP-0420. So the SCE parse below is done independently here to
prove the FULL round-trip: crypto (X3DH + ratchet + payload cipher) AND the SCE
content framing recover the exact plaintext body the plugin encrypted.

Usage: python interop_decrypt_plugin.py <plugin_msg.json> <bob_bundle.json>
Prints `RECOVERED_BODY: <text>` on success; exit 0 = full body interop success.
"""
import asyncio
import json
import os
import sys
import traceback
import xml.etree.ElementTree as ET

from interop_common import PersistentMemStorage, create_bob, BUNDLES, DEVICE_LISTS

from twomemo.twomemo import NAMESPACE
import twomemo.etree as tetree


def storage_path(bundle_path: str) -> str:
    return os.path.splitext(bundle_path)[0] + ".storage.json"


def local(tag: str) -> str:
    """Return the local name of a possibly `{ns}name` ElementTree tag."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def parse_sce_body(plaintext: bytes) -> str:
    """Independently parse the recovered bytes as a XEP-0420 SCE envelope and
    return the text of the `<content>/<body>` element."""
    env = ET.fromstring(plaintext.decode("utf-8"))
    if local(env.tag) != "envelope":
        raise ValueError(f"recovered content is <{local(env.tag)}>, expected <envelope>")
    content = next((c for c in env if local(c.tag) == "content"), None)
    if content is None:
        raise ValueError("SCE envelope has no <content>")
    body = next((c for c in content if local(c.tag) == "body"), None)
    if body is None:
        raise ValueError("SCE <content> has no <body>")
    return body.text or ""


async def main() -> None:
    msg_path = os.path.abspath(sys.argv[1])
    bundle_path = os.path.abspath(sys.argv[2])
    with open(msg_path) as f:
        pm = json.load(f)

    # 1) Reload Bob's SessionManager from the persisted storage of process 1.
    storage = PersistentMemStorage.from_file(storage_path(bundle_path))
    bob = await create_bob(storage)
    own_info, _ = await bob.get_own_device_information()
    print(f"[dec] Reloaded Bob. device_id={own_info.device_id}")

    # 2) Register the sender (Alice) so decrypt can resolve the device. The
    #    sender IK also travels inside the OMEMOKeyExchange, but python-omemo
    #    still expects the device to be present in the device list.
    alice = pm["alice"]
    alice_jid = pm.get("senderJid", "alice@localhost")
    alice_sid = alice["deviceId"]
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
    print(f"[dec] Registered Alice sid={alice_sid}")

    # 3) Reconstruct the XEP-0384 <encrypted> stanza from the plugin's serialized
    #    XML — verbatim, exactly as the plugin put it on the wire.
    enc = ET.fromstring(pm["encryptedXml"])
    message = tetree.parse_message(enc, alice_jid)
    print(f"[dec] Parsed plugin <encrypted>: sid={message.device_id} keys={len(message.keys)}")

    # 4) DECRYPT with the reference — recovers the OPAQUE SCE envelope bytes.
    print("\n[dec] === calling bob.decrypt() ===")
    plaintext, sender_device, _plain_km = await bob.decrypt(message)
    if plaintext is None:
        raise SystemExit("decrypt returned None (empty OMEMO message) — no SCE body to recover")
    print(f"[dec] recovered {len(plaintext)}B of opaque SCE content from "
          f"{sender_device.bare_jid}/{sender_device.device_id}")

    # 5) INDEPENDENTLY parse the recovered bytes as XEP-0420 SCE and extract body.
    body = parse_sce_body(plaintext)
    print(f"\nRECOVERED_BODY: {body}")
    print("\nBODY INTEROP SUCCESS: reference established the X3DH session from the plugin's "
          "KeyExchange, ran the double-ratchet + payload cipher with NO MAC/auth error, and the "
          "recovered bytes parse as a urn:xmpp:sce:1 <envelope> yielding the exact <body>.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        print("\n########## PLUGIN BODY INTEROP FAILURE / EXCEPTION ##########")
        traceback.print_exc()
        sys.exit(1)
