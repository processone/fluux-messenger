#!/usr/bin/env bash
# Docker-free OMEMO 2 crypto-interop runner (VALIDATED 2026-07-13 vs OMEMO/twomemo 2.1.0).
#
# Proves the python-omemo/twomemo reference decrypts a real @fluux/omemo message end-to-end
# (X3DH + Double Ratchet + payload cipher), with no Docker/colima required — just python3
# (>=3.11) and network access to PyPI. Reference = recipient, our lib = sender.
#
#   ./run.sh
#
# Exit 0 = CRYPTO SUCCESS. A non-zero exit / traceback means a wire constant diverges from
# the reference (first suspects: HKDF label/salt, AD ordering IK_A||IK_B, a protobuf field
# number, or a ratchet KDF label).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../../.." && pwd)"          # packages/omemo
REPO="$(cd "$PKG/../.." && pwd)"             # repo root
RUN="$HERE/_run"
VENV="$RUN/venv"
mkdir -p "$RUN"

# 1. Build the SDK if the ESM dist is missing (the node emitter imports ../../../dist/index.js).
if [ ! -f "$PKG/dist/index.js" ]; then
  echo "[run] building @fluux/omemo (dist missing)…"
  (cd "$REPO" && npm run build -w @fluux/omemo)
fi

# 2. Create the venv and install the reference stack (current OMEMO 2.x + the twomemo xml extra).
if [ ! -x "$VENV/bin/python" ]; then
  echo "[run] creating venv + installing reference (OMEMO 2.x + twomemo[xml])…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check 'OMEMO>=2,<3' 'twomemo[xml]'
fi

# 3. Drive the reference decrypt (it invokes the node emitter internally).
echo "[run] running crypto-interop decrypt…"
exec "$VENV/bin/python" "$HERE/interop_decrypt.py" "$RUN"
