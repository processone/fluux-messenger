from pathlib import Path
import json, shutil, os, tempfile
root=Path(os.environ.get('FLUUX_SHARE_LAB') or tempfile.mkdtemp(prefix='fluux-share-'))
root.mkdir(parents=True,exist_ok=True)
repo=Path.cwd()
version=json.loads((repo/'apps/fluux/src-tauri/tauri.conf.json').read_text())['version']
for name in ['Receiver','Sender','UITests']:
    (root/name).mkdir(exist_ok=True)
fixture=Path(__file__).resolve().parent
for directory, sourcefile in [('Receiver','Receiver.swift'),('Sender','Sender.swift'),('UITests','ShareUITests.swift')]:
    shutil.copyfile(fixture/sourcefile,root/directory/sourcefile)
shutil.copyfile(repo/'assets/readme/fluux-logo.png',root/'Sender/fluux-logo.png')
source=repo/'apps/fluux/src-tauri'
resource=root/'Resources/en.lproj'
resource.mkdir(parents=True,exist_ok=True)
locale=json.loads((repo/'apps/fluux/src/i18n/locales/en.json').read_text())
(resource/'Localizable.strings').write_text('\n'.join(json.dumps(k)+' = '+json.dumps(v)+';' for k,v in {'share_saved':locale['sharing']['saved'],'share_import_error':locale['sharing']['importError'],'share_close':locale['common']['close']}.items()))
def app(name, bundle):
    return {'type':'application','platform':'iOS','sources':[name], 'settings':{'base':{'PRODUCT_BUNDLE_IDENTIFIER':bundle}},'info':{'path':name+'/Info.plist','properties':{'CFBundleDisplayName':name,'UILaunchScreen':{}}}}
receiver=app('Receiver','net.processone.fluux')
receiver['info']['properties'].update({'CFBundleDisplayName':'Fluux receiver','CFBundleURLTypes':[{'CFBundleURLSchemes':['net.processone.fluux']}], 'FluuxShareGroup':'group.net.processone.fluux.share'})
receiver['dependencies']=[{'target':'FluuxShare','embed':True}]
receiver['entitlements']={'path':'Receiver/Receiver.entitlements','properties':{'com.apple.security.application-groups':['group.net.processone.fluux.share']}}
extension={'type':'app-extension','platform':'iOS'}
controller = Path(os.environ.get('FLUUX_SHARE_CONTROLLER') or source/'mobile/ios/ShareViewController.swift')
extension['sources']=[{'path':str(controller)}] + [{'path':str(source/p)} for p in ['plugins/push/ios/Sources/NotificationAvatars/ConversationDestination.swift','plugins/push/ios/Sources/NotificationAvatars/SharedNotificationStore.swift']] + [{'path':'Resources'}]
extension['settings']={'base':{'PRODUCT_BUNDLE_IDENTIFIER':'net.processone.fluux.share','APPLICATION_EXTENSION_API_ONLY':'YES','SKIP_INSTALL':'YES'}}
extension['info']={'path':'FluuxShare/Info.plist','properties':{
    'CFBundleDisplayName':'Fluux','FluuxShareGroup':'group.net.processone.fluux.share','FluuxAppScheme':'net.processone.fluux',
    'NSExtension':{'NSExtensionPointIdentifier':'com.apple.share-services','NSExtensionPrincipalClass':'$(PRODUCT_MODULE_NAME).ShareViewController','NSExtensionAttributes':{'NSExtensionActivationRule':{'NSExtensionActivationSupportsText':True,'NSExtensionActivationSupportsWebURLWithMaxCount':1,'NSExtensionActivationSupportsImageWithMaxCount':1,'NSExtensionActivationSupportsFileWithMaxCount':1}}}}}
extension['entitlements']={'path':'FluuxShare/FluuxShare.entitlements','properties':{'com.apple.security.application-groups':['group.net.processone.fluux.share']}}
tests={'type':'bundle.ui-testing','platform':'iOS','sources':['UITests'],'dependencies':[{'target':'Sender'},{'target':'Receiver'}],'settings':{'base':{'PRODUCT_BUNDLE_IDENTIFIER':'org.fluux.lab.tests','TEST_TARGET_NAME':'Sender'}}}
p={'name':'ShareRepro','options':{'deploymentTarget':{'iOS':'15.0'}},'settings':{'base':{'CODE_SIGNING_ALLOWED':'NO','CODE_SIGNING_REQUIRED':'NO','SWIFT_VERSION':'5.0','GENERATE_INFOPLIST_FILE':'YES','TARGETED_DEVICE_FAMILY':'1,2','IPHONEOS_DEPLOYMENT_TARGET':'15.0'}},'targets':{'Receiver':receiver,'Sender':app('Sender','org.fluux.lab.sender'),'FluuxShare':extension,'ShareUITests':tests}, 'schemes':{'ShareRepro':{'build':{'targets':{'Receiver':'all','Sender':'all','ShareUITests':'test'}},'test':{'targets':['ShareUITests'],'gatherCoverageData':False}}}}
for target in p['targets'].values():
    target.setdefault('settings', {}).setdefault('base', {}).update({'CURRENT_PROJECT_VERSION':'1','MARKETING_VERSION':version})
    if 'info' in target:
        target['info']['properties'].update({'CFBundleVersion':'1','CFBundleShortVersionString':version})
for name in ['Receiver','FluuxShare']:
    b=p['targets'][name]['settings']['base']
    b['ENABLE_DEBUG_DYLIB']='NO'
    b['OTHER_LDFLAGS']=['$(inherited)', '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__entitlements', '-Xlinker', f'$(SRCROOT)/{name}/{name}.entitlements']
(root/'project.yml').write_text(json.dumps(p,indent=2))
print(root)
