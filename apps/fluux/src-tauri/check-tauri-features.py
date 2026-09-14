#!/usr/bin/env python3
"""Guard the focus fix decision: the app must not opt into Tauri's unstable webview mode."""

from pathlib import Path
import sys
import tomllib


manifest = Path(__file__).with_name("Cargo.toml")
with manifest.open("rb") as stream:
    features = tomllib.load(stream)["dependencies"]["tauri"]["features"]

if "unstable" in features:
    print("tauri/unstable must remain disabled for the single-webview focus path", file=sys.stderr)
    raise SystemExit(1)

print("tauri/unstable is disabled")
