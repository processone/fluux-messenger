import json
import pathlib
import shutil
import subprocess
import sys

# Resolve and download the locked crate through Cargo, including custom source
# locations. The actual plugin still creates and delivers the notification.
repo = pathlib.Path.cwd()
lab = pathlib.Path(sys.argv[1])
fixture = pathlib.Path(__file__).parent
metadata = json.loads(subprocess.check_output([
    'cargo', 'metadata', '--locked', '--format-version', '1', '--manifest-path',
    str(repo / 'apps/fluux/src-tauri/Cargo.toml'),
], text=True, timeout=240))
notification = next(pkg for pkg in metadata['packages'] if pkg['name'] == 'tauri-plugin-notification')
version = notification['version']
plugin = pathlib.Path(notification['manifest_path']).parent / 'ios/Sources'
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
