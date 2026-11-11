from pathlib import Path
import json, shutil, os, tempfile
root = Path(os.environ.get('FLUUX_WIDGETS_LAB') or tempfile.mkdtemp(prefix='fluux-widgets-'))
root.mkdir(parents=True, exist_ok=True)
repo = Path.cwd()
here = Path(__file__).resolve().parent
src = repo / 'apps/fluux/src-tauri'
version = json.loads((src / 'tauri.conf.json').read_text())['version']
group = 'group.org.fluux.lab.widgets.share'
scheme = 'org.fluux.lab.widgets'
for name in ['Host', 'UITests']:
    (root / name).mkdir(exist_ok=True)
shutil.copyfile(here / 'Host.swift', root / 'Host/Host.swift')
shutil.copyfile(here / 'WidgetsUITests.swift', root / 'UITests/WidgetsUITests.swift')
avatars = src / 'plugins/push/ios/Sources/NotificationAvatars'
previews = src / 'plugins/push/ios/Sources/NotificationPreviews'
# Production sources, the same set the extensions compile: the host runs NotificationService in-process.
host_sources = ['Host',
    str(src / 'mobile/ios/NotificationService.swift'),
    str(src / 'plugins/push/ios/Sources/ShareSuggestions.swift'),
    str(src / 'plugins/widgets/ios/Sources/UnreadList.swift'),
    str(repo / 'scripts/native-tests/NotificationPreviewEngineStub.swift')] + \
    [str(p) for p in sorted(avatars.glob('*.swift'))] + [str(p) for p in sorted(previews.glob('*.swift'))]
widget_sources = [str(src / 'mobile/ios/Widgets'),
    str(avatars / 'ConversationDestination.swift'), str(avatars / 'SharedNotificationStore.swift'),
    str(src / 'plugins/widgets/ios/Sources/UnreadList.swift')]
def sectcreate(name):
    return ['$(inherited)', '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__entitlements', '-Xlinker', f'$(SRCROOT)/{name}/{name}.entitlements']
host = {'type': 'application', 'platform': 'iOS', 'sources': host_sources,
    'dependencies': [{'target': 'FluuxWidgets', 'embed': True}],
    'settings': {'base': {'PRODUCT_BUNDLE_IDENTIFIER': 'org.fluux.lab.widgets', 'PRODUCT_NAME': 'FluuxLab',
        'ENABLE_DEBUG_DYLIB': 'NO', 'OTHER_LDFLAGS': sectcreate('Host') + ['-lsqlite3']}},
    'info': {'path': 'Host/Info.plist', 'properties': {'CFBundleDisplayName': 'Fluux Lab', 'UILaunchScreen': {},
        'FluuxShareGroup': group, 'CFBundleURLTypes': [{'CFBundleURLSchemes': [scheme]}]}},
    'entitlements': {'path': 'Host/Host.entitlements', 'properties': {'com.apple.security.application-groups': [group]}}}
widgets = {'type': 'app-extension', 'platform': 'iOS', 'sources': widget_sources,
    'settings': {'base': {'PRODUCT_BUNDLE_IDENTIFIER': 'org.fluux.lab.widgets.widgets', 'PRODUCT_NAME': 'FluuxWidgets',
        'APPLICATION_EXTENSION_API_ONLY': 'YES', 'SKIP_INSTALL': 'YES', 'ENABLE_DEBUG_DYLIB': 'NO',
        'OTHER_LDFLAGS': sectcreate('FluuxWidgets')}},
    'info': {'path': 'FluuxWidgets/Info.plist', 'properties': {'CFBundleDisplayName': 'Fluux Lab', 'CFBundleDevelopmentRegion': 'en',
        'CFBundleLocalizations': ['en', 'fr'], 'FluuxShareGroup': group, 'FluuxAppScheme': scheme,
        'NSExtension': {'NSExtensionPointIdentifier': 'com.apple.widgetkit-extension'}}},
    'entitlements': {'path': 'FluuxWidgets/FluuxWidgets.entitlements', 'properties': {'com.apple.security.application-groups': [group]}}}
tests = {'type': 'bundle.ui-testing', 'platform': 'iOS', 'sources': ['UITests'], 'dependencies': [{'target': 'Host'}],
    'settings': {'base': {'PRODUCT_BUNDLE_IDENTIFIER': 'org.fluux.lab.widgets.tests', 'TEST_TARGET_NAME': 'Host'}}}
p = {'name': 'WidgetsLab', 'options': {'deploymentTarget': {'iOS': '17.0'}},
    'settings': {'base': {'CODE_SIGNING_ALLOWED': 'NO', 'CODE_SIGNING_REQUIRED': 'NO', 'SWIFT_VERSION': '5.0',
        'GENERATE_INFOPLIST_FILE': 'YES', 'TARGETED_DEVICE_FAMILY': '1', 'CURRENT_PROJECT_VERSION': '1', 'MARKETING_VERSION': version}},
    'targets': {'Host': host, 'FluuxWidgets': widgets, 'WidgetsUITests': tests},
    'schemes': {'WidgetsLab': {'build': {'targets': {'Host': 'all', 'WidgetsUITests': 'test'}},
        'test': {'targets': ['WidgetsUITests'], 'gatherCoverageData': False}}}}
for target in p['targets'].values():
    if 'info' in target:
        target['info']['properties'].update({'CFBundleVersion': '1', 'CFBundleShortVersionString': version})
(root / 'project.yml').write_text(json.dumps(p, indent=2))
print(root)
