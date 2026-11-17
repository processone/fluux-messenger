#!/usr/bin/env python3
"""
Shared reference-side helpers for the OMEMO 2 interop harness (python-omemo /
twomemo 2.1.0). Factored out of `interop_decrypt.py` so the two-process,
plugin-driven gate can reuse them:

  * `interop_gen_bundle.py`   — process 1: reference (Bob) generates its bundle
                                and PERSISTS its storage to disk.
  * `interop_decrypt_plugin.py` — process 2: reference RELOADS Bob's storage and
                                decrypts the plugin's `<encrypted>` stanza.

Because the plugin encrypts in between the two python invocations, Bob's private
keys (identity, signed pre-key, one-time pre-keys) must survive across processes.
`PersistentMemStorage` serializes the flat `key -> JSONType` map to a JSON file
so the second process reconstructs the exact same `SessionManager` identity.
"""
import copy
import json
from typing import Dict, Optional

from omemo import SessionManager, Storage, DeviceList, DeviceInformation, Bundle
from omemo.storage import Just, Nothing, Maybe
from omemo.types import TrustLevel, JSONType

from twomemo import Twomemo


# In-memory "network" shared across the SessionManager static callbacks within a
# single process (bundles + device lists other peers would fetch over pubsub).
BUNDLES: Dict[tuple, Bundle] = {}
DEVICE_LISTS: Dict[tuple, DeviceList] = {}


class PersistentMemStorage(Storage):
    """`Storage` backed by a flat dict that can be dumped to / loaded from JSON.

    python-omemo persists ALL long-term key material (identity key, signed
    pre-key, one-time pre-keys, ratchets, trust) through this interface, so a
    faithful dump/load round-trips a `SessionManager`'s entire secret state.
    """

    def __init__(self, initial: Optional[Dict[str, JSONType]] = None):
        super().__init__()
        self._d: Dict[str, JSONType] = dict(initial) if initial else {}

    async def _load(self, key: str) -> Maybe[JSONType]:
        return Just(self._d[key]) if key in self._d else Nothing()

    async def _store(self, key: str, value: JSONType) -> None:
        self._d[key] = copy.deepcopy(value)

    async def _delete(self, key: str) -> None:
        self._d.pop(key, None)

    def save_to(self, path: str) -> None:
        with open(path, "w") as f:
            json.dump(self._d, f)

    @classmethod
    def from_file(cls, path: str) -> "PersistentMemStorage":
        with open(path) as f:
            return cls(json.load(f))


class InteropSessionManager(SessionManager):
    """Auto-trusting `SessionManager` whose pubsub callbacks read/write the
    in-process `BUNDLES` / `DEVICE_LISTS` maps. Trust decisions are made
    permissive so decryption is never blocked on an interop run."""

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
    async def _send_message(message, bare_jid: str) -> None:
        pass  # history-sync mode during decrypt; not called


async def create_bob(storage: Storage) -> "InteropSessionManager":
    """Create (or reload, when `storage` is populated) Bob's SessionManager."""
    return await InteropSessionManager.create(
        backends=[Twomemo(storage)],
        storage=storage,
        own_bare_jid="bob@localhost",
        initial_own_label=None,
        undecided_trust_level_name="undecided",
    )
