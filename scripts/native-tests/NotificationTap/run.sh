#!/bin/bash
# FLM-95: actual local notification plugin + production tap delegate, no signing or accounts.
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${FLUUX_TAP_RESULTS:?Choose an absolute evidence directory outside the project}"
python3 - "$FLUUX_TAP_RESULTS" <<'PY'
import pathlib, sys
root = pathlib.Path.cwd().resolve()
output = pathlib.Path(sys.argv[1])
if not output.is_absolute() or output.resolve().is_relative_to(root):
    raise SystemExit('FLUUX_TAP_RESULTS must be absolute and outside the project')
output.mkdir(parents=True, exist_ok=True)
PY
LAB="$(mktemp -d "${TMPDIR:-/tmp}/fluux-notification-tap.XXXXXX")"
SIM=""
cleanup() {
  if [[ -n "$SIM" ]]; then
    xcrun simctl shutdown "$SIM" >/dev/null 2>&1 || true
    xcrun simctl delete "$SIM" >/dev/null 2>&1 || true
  fi
  rm -rf "$LAB"
}
trap cleanup EXIT
python3 scripts/native-tests/NotificationTap/setup.py "$LAB"
(cd "$LAB" && xcodegen generate)
SIM="$(xcrun simctl create Fluux-notification-tap "${FLUUX_TAP_DEVICE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}" "${FLUUX_TAP_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}")"
xcrun simctl boot "$SIM"
xcrun simctl bootstatus "$SIM" -b
xcodebuild -project "$LAB/NotificationTap.xcodeproj" -scheme NotificationTap \
  -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath "$LAB/Build" \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  -resultBundlePath "$FLUUX_TAP_RESULTS/taps.xcresult" CODE_SIGNING_ALLOWED=NO test \
  > "$FLUUX_TAP_RESULTS/native-taps.log" 2>&1
xcrun xcresulttool export attachments --path "$FLUUX_TAP_RESULTS/taps.xcresult" --output-path "$FLUUX_TAP_RESULTS/attachments"
