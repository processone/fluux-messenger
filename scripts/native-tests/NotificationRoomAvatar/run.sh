#!/bin/bash
# Native regression for room-first alerts with the room's cached image.
# Run from the project root; no signing, account, Keychain or APNs access.
set -euo pipefail
: "${FLUUX_ROOM_AVATAR_RESULTS:?Choose an absolute evidence directory outside the project}"
python3 - "$FLUUX_ROOM_AVATAR_RESULTS" <<'PY'
import pathlib, sys
output = pathlib.Path(sys.argv[1])
if not output.is_absolute() or output.resolve().is_relative_to(pathlib.Path.cwd().resolve()):
    raise SystemExit('Results must be absolute and outside the project')
output.mkdir(parents=True, exist_ok=True)
PY
RESULTS="$(mktemp -d "$FLUUX_ROOM_AVATAR_RESULTS/run-XXXXXX")"
LAB="$(mktemp -d "${FLUUX_ROOM_AVATAR_TEMP:-${TMPDIR:-/tmp}}/fluux-room-avatar.XXXXXX")"
SIM=""
cleanup() {
  if [[ -n "$SIM" ]]; then
    xcrun simctl shutdown "$SIM" >/dev/null 2>&1 || true
    xcrun simctl delete "$SIM" >/dev/null 2>&1 || true
  fi
  rm -rf "$LAB"
}
trap cleanup EXIT
python3 scripts/native-tests/NotificationRoomAvatar/setup.py "$LAB" > "$RESULTS/manifest.json"
(cd "$LAB" && xcodegen generate)
SIM="$(xcrun simctl create Fluux-room-avatar-fixture "${FLUUX_ROOM_AVATAR_DEVICE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}" "${FLUUX_ROOM_AVATAR_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}")"
xcrun simctl boot "$SIM"
xcrun simctl bootstatus "$SIM" -b
args=()
if [[ "${FLUUX_ROOM_AVATAR_NATIVE_ONLY:-0}" == 1 ]]; then args+=( -only-testing:NativeTests ); fi
if [[ "${FLUUX_ROOM_AVATAR_ITERATIONS:-1}" != 1 ]]; then args+=( -test-iterations "$FLUUX_ROOM_AVATAR_ITERATIONS" ); fi
set +e
xcodebuild -project "$LAB/RoomAvatarLab.xcodeproj" -scheme RoomAvatarLab \
  -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath "$LAB/Build" \
  -jobs 2 -parallel-testing-enabled NO -collect-test-diagnostics never \
  -resultBundlePath "$RESULTS/room-avatar.xcresult" "${args[@]}" CODE_SIGNING_ALLOWED=NO test \
  > "$RESULTS/build.log" 2>&1
STATUS=$?
set -e
xcrun xcresulttool get test-results summary --path "$RESULTS/room-avatar.xcresult" --format json > "$RESULTS/summary.json" || true
xcrun xcresulttool export attachments --path "$RESULTS/room-avatar.xcresult" --output-path "$RESULTS/attachments" || true
printf 'Room-avatar checks exited %s. Evidence: %s\n' "$STATUS" "$RESULTS"
exit "$STATUS"
