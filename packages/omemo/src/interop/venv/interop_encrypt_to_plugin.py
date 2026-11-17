#!/usr/bin/env python3
"""
Reverse direction of the plugin interop gate: the reference (Bob) ENCRYPTS to the
plugin (Alice). Reloads Bob's persisted storage, registers the plugin's published
bundle, encrypts two XEP-0420 SCE envelopes to it with twomemo (the first is a key
exchange, the second an ordinary ratchet message) and writes both serialized
`<encrypted xmlns='urn:xmpp:omemo:2'>` stanzas to the output JSON.

Usage: python interop_encrypt_to_plugin.py <plugin_bundle.json> <bob_bundle.json> <out.json> <text1> <text2>
"""
import asyncio
import json
import os
import sys
import traceback
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

from interop_common import PersistentMemStorage, create_bob, BUNDLES, DEVICE_LISTS

from twomemo.twomemo import NAMESPACE
import twomemo.etree as tetree


ET.register_namespace("", NAMESPACE)


def storage_path(bundle_path: str) -> str:
    return os.path.splitext(bundle_path)[0] + ".storage.json"


def sce_envelope(text: str, to_jid: str, from_jid: str) -> bytes:
    """A XEP-0420 envelope as an XMPP library would put it on the wire: default namespaces,
    the body in jabber:client."""
    return (
        '<envelope xmlns="urn:xmpp:sce:1">'
        f'<content><body xmlns="jabber:client">{escape(text)}</body></content>'
        f'<rpad>{"x" * 11}</rpad>'
        f'<to jid="{escape(to_jid)}"/><from jid="{escape(from_jid)}"/>'
        '<time stamp="2026-01-01T00:00:00Z"/>'
        '</envelope>'
    ).encode("utf8")


async def main() -> None:
    plugin_path, bundle_path, out_path = (os.path.abspath(a) for a in sys.argv[1:4])
    texts = sys.argv[4:]
    with open(plugin_path) as f:
        alice = json.load(f)
    storage = PersistentMemStorage.from_file(storage_path(bundle_path))
    bob = await create_bob(storage)

    alice_jid = "alice@localhost"
    sid = alice["deviceId"]
    NS = f"{{{NAMESPACE}}}"
    bundle_elt = ET.Element(f"{NS}bundle")
    ET.SubElement(bundle_elt, f"{NS}spk", attrib={"id": str(alice["spkId"])}).text = alice["spk"]
    ET.SubElement(bundle_elt, f"{NS}spks").text = alice["spkSig"]
    ET.SubElement(bundle_elt, f"{NS}ik").text = alice["ik"]
    prekeys_elt = ET.SubElement(bundle_elt, f"{NS}prekeys")
    for pk in alice["preKeys"]:
        ET.SubElement(prekeys_elt, f"{NS}pk", attrib={"id": str(pk["id"])}).text = pk["key"]
    BUNDLES[(NAMESPACE, alice_jid, sid)] = tetree.parse_bundle(bundle_elt, alice_jid, sid)
    DEVICE_LISTS[(NAMESPACE, alice_jid)] = {sid: None}
    await bob.update_device_list(NAMESPACE, alice_jid, {sid: None})

    stanzas = []
    for text in texts:
        messages, errors = await bob.encrypt(
            frozenset([alice_jid]),
            {NAMESPACE: sce_envelope(text, alice_jid, "bob@localhost")},
        )
        if errors:
            raise SystemExit(f"encrypt reported errors: {errors}")
        message = next(iter(messages.keys()))
        stanzas.append(ET.tostring(tetree.serialize_message(message), encoding="unicode"))
    with open(out_path, "w") as f:
        json.dump({"stanzas": stanzas}, f)
    storage.save_to(storage_path(bundle_path))
    print(f"[enc] encrypted {len(stanzas)} messages to {alice_jid}/{sid}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        print("\n########## REFERENCE ENCRYPT FAILURE / EXCEPTION ##########")
        traceback.print_exc()
        sys.exit(1)
