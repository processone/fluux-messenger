#!/bin/bash
# Simulator widget lab. No signing, accounts, network or existing simulator data.
set -euo pipefail
cd "$(dirname "$0")/../../.."
LAB="$(mktemp -d "${TMPDIR:-/tmp}/fluux-ios-widgets.XXXXXX")"
SIM=""
cleanup() {
  if [[ -n "$SIM" ]]; then
    xcrun simctl shutdown "$SIM" >/dev/null 2>&1 || true
    xcrun simctl delete "$SIM" >/dev/null 2>&1 || true
  fi
  rm -rf "$LAB"
}
trap cleanup EXIT
: "${FLUUX_WIDGETS_RESULTS:?Set FLUUX_WIDGETS_RESULTS to a directory outside the project for logs, results and pictures}"
mkdir -p "$FLUUX_WIDGETS_RESULTS"
rm -rf "$FLUUX_WIDGETS_RESULTS/widgets.xcresult" "$FLUUX_WIDGETS_RESULTS/attachments"
FLUUX_WIDGETS_LAB="$LAB" python3 scripts/native-tests/ios-widgets/setup.py
(cd "$LAB" && xcodegen generate)
SIM="$(xcrun simctl create Fluux-widgets com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro "${FLUUX_WIDGETS_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}")"
# The test matches Home Screen labels in English whatever the Mac's language is: set it, then restart.
xcrun simctl boot "$SIM"
xcrun simctl bootstatus "$SIM" -b
xcrun simctl spawn "$SIM" defaults write -g AppleLanguages -array en
xcrun simctl spawn "$SIM" defaults write -g AppleLocale -string en_US
xcrun simctl shutdown "$SIM"
xcrun simctl boot "$SIM"
xcrun simctl bootstatus "$SIM" -b
XB=(xcodebuild -project "$LAB/WidgetsLab.xcodeproj" -scheme WidgetsLab -configuration Debug
  -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath "$LAB/DerivedData"
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO)
"${XB[@]}" build-for-testing > "$FLUUX_WIDGETS_RESULTS/build.log" 2>&1
# The hourly re-read step waits up to 80 minutes: it runs only when FLUUX_WIDGETS_HOURLY=1 (xcodebuild hands
# TEST_RUNNER_ variables to the tests).
[[ "${FLUUX_WIDGETS_HOURLY:-}" == "1" ]] && export TEST_RUNNER_FLUUX_WIDGETS_HOURLY=1
status=0
"${XB[@]}" test-without-building -parallel-testing-enabled NO -collect-test-diagnostics never \
  -resultBundlePath "$FLUUX_WIDGETS_RESULTS/widgets.xcresult" > "$FLUUX_WIDGETS_RESULTS/test.log" 2>&1 || status=$?
xcrun xcresulttool export attachments --path "$FLUUX_WIDGETS_RESULTS/widgets.xcresult" \
  --output-path "$FLUUX_WIDGETS_RESULTS/attachments" >/dev/null 2>&1 || true
exit $status
