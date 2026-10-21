#!/bin/bash
# Native image-share regression. No signing, accounts, or existing simulator data.
set -euo pipefail
cd "$(dirname "$0")/../../.."
LAB="$(mktemp -d "${TMPDIR:-/tmp}/fluux-ios-share.XXXXXX")"
SIM=""
cleanup() {
  if [[ -n "$SIM" ]]; then
    xcrun simctl shutdown "$SIM" >/dev/null 2>&1 || true
    xcrun simctl delete "$SIM" >/dev/null 2>&1 || true
  fi
  rm -rf "$LAB"
}
trap cleanup EXIT
: "${FLUUX_SHARE_RESULTS:?Set FLUUX_SHARE_RESULTS to a directory outside the project for logs and results}"
mkdir -p "$FLUUX_SHARE_RESULTS"
FLUUX_SHARE_LAB="$LAB" python3 scripts/native-tests/ios-share/setup.py
(cd "$LAB" && xcodegen generate)
SIM="$(xcrun simctl create Fluux-share-images com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro "${FLUUX_SHARE_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}")"
xcrun simctl boot "$SIM"
xcrun simctl bootstatus "$SIM" -b
XB=(xcodebuild -project "$LAB/ShareRepro.xcodeproj" -scheme ShareRepro -configuration Debug
  -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath "$LAB/DerivedData"
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO)
"${XB[@]}" build-for-testing > "$FLUUX_SHARE_RESULTS/build.log" 2>&1
# Xcode installs the UI test's sender, but not its separate receiver dependency.
for app in Receiver Sender; do
  xcrun simctl install "$SIM" "$LAB/DerivedData/Build/Products/Debug-iphonesimulator/$app.app"
done
"${XB[@]}" test-without-building -parallel-testing-enabled NO -collect-test-diagnostics never \
  -resultBundlePath "$FLUUX_SHARE_RESULTS/images.xcresult" > "$FLUUX_SHARE_RESULTS/test.log" 2>&1
