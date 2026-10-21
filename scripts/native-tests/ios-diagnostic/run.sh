#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${FLUUX_DIAGNOSTIC_RESULTS:?Choose an evidence directory outside the project}"
LAB="$(mktemp -d "${TMPDIR:-/tmp}/fluux-diagnostic.XXXXXX")"
SIM=""
trap 'if [[ -n "$SIM" ]]; then xcrun simctl shutdown "$SIM" >/dev/null 2>&1 || true; xcrun simctl delete "$SIM" >/dev/null 2>&1 || true; fi; rm -rf "$LAB"' EXIT
mkdir -p "$FLUUX_DIAGNOSTIC_RESULTS"
python3 - "$LAB" <<'PY'
import sys,json,pathlib,shutil
lab=pathlib.Path(sys.argv[1]); repo=pathlib.Path.cwd()
for name in ['App','UITests']: (lab/name).mkdir()
shutil.copyfile(repo/'scripts/native-tests/ios-diagnostic/App.swift',lab/'App/App.swift')
shutil.copyfile(repo/'scripts/native-tests/ios-diagnostic/UITests.swift',lab/'UITests/UITests.swift')
source=repo/'apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationPreviews/PreviewTrace.swift'
version=json.loads((repo/'apps/fluux/src-tauri/tauri.conf.json').read_text())['version']
p={'name':'Diagnostic','settings':{'base':{'SWIFT_VERSION':'5.0','CODE_SIGNING_ALLOWED':'NO','GENERATE_INFOPLIST_FILE':'YES','MARKETING_VERSION':version,'CURRENT_PROJECT_VERSION':'1','TARGETED_DEVICE_FAMILY':'1,2'}},'targets':{'App':{'type':'application','platform':'iOS','deploymentTarget':'15.0','sources':['App',str(source)],'settings':{'base':{'PRODUCT_BUNDLE_IDENTIFIER':'org.fluux.lab.diagnostic','OTHER_LDFLAGS':['-lsqlite3']}},'info':{'path':'App/Info.plist','properties':{'UILaunchScreen':{},'CFBundleShortVersionString':version,'CFBundleVersion':'1'}}},'UITests':{'type':'bundle.ui-testing','platform':'iOS','deploymentTarget':'15.0','sources':['UITests'],'dependencies':[{'target':'App'}],'settings':{'base':{'PRODUCT_BUNDLE_IDENTIFIER':'org.fluux.lab.diagnostic.tests','TEST_TARGET_NAME':'App'}}}},'schemes':{'Diagnostic':{'build':{'targets':{'App':'all','UITests':'test'}},'test':{'targets':['UITests']}}}}
(lab/'project.yml').write_text(json.dumps(p))
PY
(cd "$LAB" && xcodegen generate)
SIM="$(xcrun simctl create Fluux-diagnostic com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-5)"
xcrun simctl boot "$SIM"
xcrun simctl bootstatus "$SIM" -b
xcodebuild -project "$LAB/Diagnostic.xcodeproj" -scheme Diagnostic -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath "$LAB/Build" -parallel-testing-enabled NO -collect-test-diagnostics never -resultBundlePath "$FLUUX_DIAGNOSTIC_RESULTS/share.xcresult" CODE_SIGNING_ALLOWED=NO test > "$FLUUX_DIAGNOSTIC_RESULTS/native-share.log" 2>&1
xcrun xcresulttool export attachments --path "$FLUUX_DIAGNOSTIC_RESULTS/share.xcresult" --output-path "$FLUUX_DIAGNOSTIC_RESULTS/attachments"
