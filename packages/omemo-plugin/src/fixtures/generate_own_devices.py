#!/usr/bin/env python3
"""Generates own_devices.json: device lists and bundles for one account with three OMEMO 2 devices and two legacy devices,
serialized by the reference python-omemo stack (OMEMO 2.1.0, Twomemo 2.1.0, Oldmemo 2.1.0) with the
same `etree.serialize_*` functions the slixmpp-omemo client publishes. Nothing is hand-typed XML.

  python3.13 -m venv v && v/bin/pip install 'OMEMO>=2,<3' 'twomemo[xml]' 'oldmemo[xml]'
  v/bin/python generate_own_devices.py own_devices.json

Note: the reference's legacy list serializer writes no labels ("not supported by this version of the
specification"), so the legacy fixture carries none; OMEMO 2 labels are signed as the reference does.
"""
import asyncio, copy, json, sys
import xml.etree.ElementTree as ET
from importlib.metadata import version

import oldmemo, oldmemo.etree, twomemo, twomemo.etree
from omemo import SessionManager, Storage
from omemo.storage import Just, Nothing
from omemo.types import TrustLevel

JID = "me@example.org"
LISTS, BUNDLES = {}, {}


class Mem(Storage):
    def __init__(self): super().__init__(); self.d = {}
    async def _load(self, k): return Just(self.d[k]) if k in self.d else Nothing()
    async def _store(self, k, v): self.d[k] = copy.deepcopy(v)
    async def _delete(self, k): self.d.pop(k, None)


class Manager(SessionManager):
    @staticmethod
    async def _upload_bundle(b): BUNDLES[(b.namespace, b.device_id)] = b
    @staticmethod
    async def _download_bundle(ns, jid, dev): return BUNDLES[(ns, dev)]
    @staticmethod
    async def _delete_bundle(ns, dev): BUNDLES.pop((ns, dev), None)
    @staticmethod
    async def _upload_device_list(ns, dl): LISTS[ns] = dict(dl)
    @staticmethod
    async def _download_device_list(ns, jid): return dict(LISTS.get(ns, {}))
    async def _evaluate_custom_trust_level(self, d): return TrustLevel.TRUSTED
    async def _make_trust_decision(self, undecided, identifier=None): pass
    @staticmethod
    async def _send_message(m, jid): pass


async def main(out):
    # The legacy backend cannot carry labels, so the two protocols' devices are separate installs.
    for backend, label in ((twomemo.Twomemo, "Laptop"), (twomemo.Twomemo, "Phone"), (twomemo.Twomemo, None),
                           (oldmemo.Oldmemo, None), (oldmemo.Oldmemo, None)):
        s = Mem()
        await Manager.create(
            backends=[backend(s)], storage=s, own_bare_jid=JID,
            initial_own_label=label, undecided_trust_level_name="undecided")
    xml = lambda e: ET.tostring(e, encoding="unicode")
    result = {
        "provenance": {
            "generator": "generate_own_devices.py", "OMEMO": version("OMEMO"),
            "Twomemo": version("Twomemo"), "Oldmemo": version("Oldmemo"),
        },
        "omemo2": {"devices": xml(twomemo.etree.serialize_device_list(LISTS[twomemo.twomemo.NAMESPACE])), "bundles": {}},
        "legacy": {"devices": xml(oldmemo.etree.serialize_device_list(LISTS[oldmemo.oldmemo.NAMESPACE])), "bundles": {}},
    }
    for (ns, dev), b in BUNDLES.items():
        if ns == twomemo.twomemo.NAMESPACE:
            result["omemo2"]["bundles"][str(dev)] = xml(twomemo.etree.serialize_bundle(b))
        elif ns == oldmemo.oldmemo.NAMESPACE:
            result["legacy"]["bundles"][str(dev)] = xml(oldmemo.etree.serialize_bundle(b))
    json.dump(result, open(out, "w"), indent=2)

asyncio.run(main(sys.argv[1]))
