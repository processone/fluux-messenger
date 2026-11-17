#!/usr/bin/env python3
"""
Process 1 of the plugin body-level interop gate: the reference (Bob) generates
its own OMEMO 2 identity + bundle, writes the bundle to `<out>` as JSON, and
PERSISTS Bob's full storage next to it (`<out>` with a `.storage.json` sibling)
so `interop_decrypt_plugin.py` can reload the exact same identity and decrypt.

Usage: python interop_gen_bundle.py <bob_bundle.json>
Exit 0 = bundle generated + storage persisted.
"""
import asyncio
import base64
import json
import os
import sys
import traceback

from interop_common import PersistentMemStorage, create_bob


def storage_path(bundle_path: str) -> str:
    return os.path.splitext(bundle_path)[0] + ".storage.json"


async def main() -> None:
    out_path = os.path.abspath(sys.argv[1])
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    storage = PersistentMemStorage()
    bob = await create_bob(storage)

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
    with open(out_path, "w") as f:
        json.dump(bob_json, f, indent=2)

    # Persist Bob's secret state so the decrypt process reloads the SAME identity.
    storage.save_to(storage_path(out_path))

    print(
        f"[gen] Bob generated. device_id={bob_dev} ik={len(xb.identity_key)}B "
        f"spk={len(xb.signed_pre_key)}B spks={len(xb.signed_pre_key_sig)}B "
        f"prekeys={len(bob_json['preKeys'])} storage_keys={len(storage._d)}"
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        print("\n########## BUNDLE GEN FAILURE / EXCEPTION ##########")
        traceback.print_exc()
        sys.exit(1)
