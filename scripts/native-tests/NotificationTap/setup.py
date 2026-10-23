import json
import os
import pathlib
import shutil
import sys
import tomllib

# Use the locked, downloaded crate unchanged. No notification payload is
# reconstructed here: the actual plugin creates and delivers the request.
repo = pathlib.Path.cwd()
lab = pathlib.Path(sys.argv[1])
fixture = pathlib.Path(__file__).parent
lock = tomllib.loads((repo / 'apps/fluux/src-tauri/Cargo.lock').read_text())
version = next(pkg['version'] for pkg in lock['package'] if pkg['name'] == 'tauri-plugin-notification')
cargo = pathlib.Path(os.environ.get('CARGO_HOME', pathlib.Path.home() / '.cargo'))
plugin = next((cargo / 'registry/src').glob(f'*/tauri-plugin-notification-{version}/ios/Sources'), None)
if plugin is None:
    raise SystemExit(f'Fetch the locked notification crate {version} before running this fixture')
for name in ['App', 'UITests', 'Tauri', 'SwiftRs']:
    (lab / name).mkdir()
source = (repo / 'apps/fluux/src-tauri/plugins/push/ios/Sources/PushPlugin.swift').read_text()
# Compile the complete production delegate, with its original access control,
# beside the test bridge, without launching the production app or any account.
start = source.index('private class RemoteNotificationDelegate:')
end = source.index('\nprivate struct DismissTarget:', start)
(lab / 'App/App.swift').write_text((fixture / 'App.swift').read_text() + '\n' + source[start:end])
shutil.copyfile(fixture / 'UITests.swift', lab / 'UITests/UITests.swift')
shutil.copyfile(fixture / 'Tauri.swift', lab / 'Tauri/Tauri.swift')
shutil.copyfile(fixture / 'payloads.json', lab / 'App/payloads.json')
(lab / 'SwiftRs/SwiftRs.swift').write_text('import Foundation\n')
settings = {'SWIFT_VERSION': '5.0', 'CODE_SIGNING_ALLOWED': 'NO', 'GENERATE_INFOPLIST_FILE': 'YES', 'IPHONEOS_DEPLOYMENT_TARGET': '15.0', 'TARGETED_DEVICE_FAMILY': '1,2'}
project = {'name': 'NotificationTap', 'settings': {'base': settings}, 'targets': {}}
for name in ['Tauri', 'SwiftRs']:
    project['targets'][name] = {'type': 'framework', 'platform': 'iOS', 'sources': [name], 'settings': {'base': {'PRODUCT_BUNDLE_IDENTIFIER': 'org.fluux.lab.' + name, 'DEFINES_MODULE': 'YES'}}}
project['targets']['App'] = {'type': 'application', 'platform': 'iOS', 'sources': ['App', str(plugin)], 'dependencies': [{'target': name} for name in ['Tauri', 'SwiftRs']], 'settings': {'base': {'PRODUCT_BUNDLE_IDENTIFIER': 'org.fluux.lab.notification-tap'}}, 'info': {'path': 'App/Info.plist', 'properties': {'UILaunchScreen': {}, 'CFBundleDisplayName': 'Notification tap fixture'}}}
project['targets']['UITests'] = {'type': 'bundle.ui-testing', 'platform': 'iOS', 'sources': ['UITests'], 'dependencies': [{'target': 'App'}], 'settings': {'base': {'PRODUCT_BUNDLE_IDENTIFIER': 'org.fluux.lab.notification-tap.tests', 'TEST_TARGET_NAME': 'App'}}}
project['schemes'] = {'NotificationTap': {'build': {'targets': {'App': 'all', 'UITests': 'test'}}, 'test': {'targets': ['UITests']}}}
(lab / 'project.yml').write_text(json.dumps(project))
print(f'Testing notification plugin {version} with the production Fluux delegate')
