#!/usr/bin/env bash
# FLM-366: build only; never discovers a device or reads pairing material.
set -euo pipefail
if [ "$#" -ne 1 ] || [[ "$1" != /* ]]; then
  echo 'Usage: bash scripts/inspector/build-service.sh /absolute/output/file' >&2
  exit 1
fi
root=$(cd "$(dirname "$0")" && pwd)
pkg-config --atleast-version=2.3.0 libplist-2.0
pkg-config --atleast-version=3.0.0 openssl
# pkg-config emits compiler arguments for trusted, installed development packages.
read -r -a flags <<< "$(pkg-config --cflags --libs libplist-2.0 openssl)"
"${CC:-cc}" -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -O2 \
  "$root/service_worker.c" "${flags[@]}" -o "$1"
