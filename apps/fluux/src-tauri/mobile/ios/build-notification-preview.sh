#!/bin/sh
set -eu
NSE_SOURCE="${SRCROOT}/../../nse-openpgp"
NSE_OUTPUT="${DERIVED_FILE_DIR}/NotificationPreview"
export PATH="${HOME}/.cargo/bin:${PATH}"
export CARGO_TARGET_DIR="${NSE_OUTPUT}/target"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-15.0}"
mkdir -p "${NSE_OUTPUT}/lib"
set --
for NSE_ARCH in ${ARCHS}; do
    case "${PLATFORM_NAME}:${NSE_ARCH}" in
      iphoneos:arm64) NSE_TARGET=aarch64-apple-ios ;;
      iphonesimulator:arm64) NSE_TARGET=aarch64-apple-ios-sim ;;
      iphonesimulator:x86_64) NSE_TARGET=x86_64-apple-ios ;;
      *) echo 'Unsupported notification-preview architecture' >&2; exit 1 ;;
    esac
    cargo build --locked --release --lib --target "${NSE_TARGET}" --manifest-path "${NSE_SOURCE}/Cargo.toml"
    set -- "$@" "${CARGO_TARGET_DIR}/${NSE_TARGET}/release/libfluux_nse_openpgp.a"
done
xcrun lipo -create "$@" -output "${NSE_OUTPUT}/lib/libfluux_nse_openpgp.a"
