#!/usr/bin/env python3
"""Unsigned native room-notification regression fixture. Run from the project root.
Usage: python3 scripts/native-tests/NotificationRoomAvatar/setup.py LAB_DIRECTORY
No signing, account, Keychain, APNs or installed Fluux application is used.
Only NotificationMirror.root is redirected to the fixture app's sandbox.
The production presentation code is copied unchanged; only the mirror root is isolated.
"""
import hashlib
import json
import pathlib
import subprocess
import sys

repo = pathlib.Path.cwd()
lab = pathlib.Path(sys.argv[1]).resolve()
rev = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
fixture = pathlib.Path(__file__).resolve().parent
lab.mkdir(parents=True, exist_ok=True)
for name in ['App', 'Native', 'Tests', 'UITests']:
    (lab / name).mkdir(exist_ok=True)
base = 'apps/fluux/src-tauri/plugins/push/ios/Sources/'
paths = [base + 'NotificationAvatars/' + x for x in [
    'SharedNotificationStore.swift', 'SharedBadge.swift', 'NotificationPresentation.swift',
    'ConversationDestination.swift', 'NotificationSoundSettings.swift']]
paths += [base + 'NotificationPreviews/PreviewResult.swift']
manifest = {'revision': rev, 'sources': {}, 'standIn': 'NotificationMirror.root only: private fixture app Caches/RoomAvatarFixture'}
for path in paths:
    data = (repo / path).read_bytes()
    manifest['sources'][path] = hashlib.sha256(data).hexdigest()
    text = data.decode()
    if path.endswith('SharedNotificationStore.swift'):
        old = '''        guard let group = Bundle.main.object(forInfoDictionaryKey: "FluuxShareGroup") as? String else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)'''
        assert text.count(old) == 1
        text = text.replace(old, '''        // Lab filesystem boundary only; production presentation logic is unchanged.
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!.appendingPathComponent("RoomAvatarFixture", isDirectory: true)''')
    (lab / 'Native' / pathlib.Path(path).name).write_text(text)
image_path = 'assets/readme/fluux-logo.png'
image = (repo / image_path).read_bytes()
(lab / 'App/room-avatar.png').write_bytes(image)
for scale in ['2x', '3x']:
    icon = (repo / f'apps/fluux/src-tauri/icons/ios/AppIcon-60x60@{scale}.png').read_bytes()
    (lab / f'App/Icon60@{scale}.png').write_bytes(icon)
manifest['fixtureImage'] = {'source': image_path, 'sha256': hashlib.sha256(image).hexdigest(), 'note': 'Real project logo assigned as the disposable room image.'}
(lab / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
for source, target in [('App.swift', 'App/App.swift'), ('RoomAvatarTests.swift', 'Tests/RoomAvatarTests.swift'), ('UITests.swift', 'UITests/RoomAlertUITests.swift')]:
    (lab / target).write_text((fixture / source).read_text())
settings = {'SWIFT_VERSION': '5.0', 'CODE_SIGNING_ALLOWED': 'NO', 'GENERATE_INFOPLIST_FILE': 'YES', 'IPHONEOS_DEPLOYMENT_TARGET': '15.0', 'TARGETED_DEVICE_FAMILY': '1,2', 'PRODUCT_NAME': 'AvatarLab'}
project = {'name': 'RoomAvatarLab', 'settings': {'base': settings}, 'targets': {
    'AvatarLab': {'type': 'application', 'platform': 'iOS', 'sources': ['App', 'Native'], 'settings': {'base': {'PRODUCT_BUNDLE_IDENTIFIER': 'org.fluux.lab.room-avatar'}}, 'info': {'path': 'App/Info.plist', 'properties': {'UILaunchScreen': {}, 'CFBundleDisplayName': 'Fluux avatar fixture', 'CFBundleIcons': {'CFBundlePrimaryIcon': {'CFBundleIconFiles': ['Icon60']}}, 'NSUserActivityTypes': ['INSendMessageIntent']}}},
    'NativeTests': {'type': 'bundle.unit-test', 'platform': 'iOS', 'sources': ['Tests'], 'dependencies': [{'target': 'AvatarLab'}], 'settings': {'base': {'PRODUCT_BUNDLE_IDENTIFIER': 'org.fluux.lab.room-avatar.tests', 'PRODUCT_NAME': 'NativeTests'}}},
    'UITests': {'type': 'bundle.ui-testing', 'platform': 'iOS', 'sources': ['UITests'], 'dependencies': [{'target': 'AvatarLab'}], 'settings': {'base': {'PRODUCT_BUNDLE_IDENTIFIER': 'org.fluux.lab.room-avatar.ui', 'PRODUCT_NAME': 'UITests', 'TEST_TARGET_NAME': 'AvatarLab'}}}},
    'schemes': {'RoomAvatarLab': {'build': {'targets': {'AvatarLab': 'all', 'NativeTests': 'test', 'UITests': 'test'}}, 'test': {'targets': ['NativeTests', 'UITests']}}}}
(lab / 'project.yml').write_text(json.dumps(project, indent=2))
print(json.dumps(manifest, indent=2))
