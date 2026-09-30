import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { prepareAndroid } from '../apps/fluux/scripts/tauri-android-prepare.mjs'

const androidAttribute = (element, name) => element.getAttributeNS('http://schemas.android.com/apk/res/android', name)
const parseXml = text => new JSDOM(text, { contentType: 'application/xml' }).window.document

test('Android preparation emits network and activity configuration and copies the keyboard plugin byte-for-byte, idempotently', () => {
  const project = mkdtempSync(join(tmpdir(), 'fluux-android-'))
  try {
    const main = join(project, 'app/src/main')
    mkdirSync(main, { recursive: true })
    const manifest = join(main, 'AndroidManifest.xml')
    writeFileSync(manifest, `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:label="Fluux" android:usesCleartextTraffic="true">
      <activity android:name=".MainActivity" />
    </application>
    </manifest>`)
    prepareAndroid(project)
    const first = readFileSync(manifest, 'utf8')
    const document = parseXml(first)
    const application = document.querySelector('manifest > application')
    assert.ok(application)
    assert.equal(androidAttribute(application, 'networkSecurityConfig'), '@xml/fluux_network_security_config')
    assert.equal(androidAttribute(application, 'label'), 'Fluux')
    assert.equal(androidAttribute(application, 'usesCleartextTraffic'), 'false')
    assert.deepEqual(Array.from(document.querySelectorAll('manifest > uses-permission'), element => androidAttribute(element, 'name')).sort(), [
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.INTERNET',
    ])
    const activities = Array.from(application.querySelectorAll('activity'))
    assert.equal(activities.length, 2)
    assert.deepEqual(Object.fromEntries(activities.map(activity => [androidAttribute(activity, 'name'), androidAttribute(activity, 'windowSoftInputMode')])), {
      '.MainActivity': 'adjustResize',
      'com.processone.shareinbox.ReceiveShareActivity': null,
    })
    const receiver = activities.find(activity => androidAttribute(activity, 'name') === 'com.processone.shareinbox.ReceiveShareActivity')
    assert.ok(receiver)
    assert.equal(androidAttribute(receiver, 'exported'), 'true')
    assert.equal(androidAttribute(receiver, 'excludeFromRecents'), 'true')
    assert.deepEqual(Array.from(receiver.querySelectorAll('intent-filter'), filter => ({
      actions: Array.from(filter.querySelectorAll('action'), element => androidAttribute(element, 'name')),
      categories: Array.from(filter.querySelectorAll('category'), element => androidAttribute(element, 'name')),
      mimeTypes: Array.from(filter.querySelectorAll('data'), element => androidAttribute(element, 'mimeType')),
    })), [{ actions: ['android.intent.action.SEND'], categories: ['android.intent.category.DEFAULT'], mimeTypes: ['*/*'] }])
    const policyPath = join(main, 'res/xml/fluux_network_security_config.xml')
    const policy = parseXml(readFileSync(policyPath, 'utf8'))
    assert.equal(policy.documentElement.localName, 'network-security-config')
    assert.deepEqual(Array.from(policy.querySelectorAll('base-config'), element => element.getAttribute('cleartextTrafficPermitted')), ['false'])
    assert.deepEqual(Array.from(policy.querySelectorAll('domain-config'), config => ({
      cleartextTrafficPermitted: config.getAttribute('cleartextTrafficPermitted'),
      domains: Array.from(config.querySelectorAll('domain'), domain => ({
        name: domain.textContent.trim(),
        includeSubdomains: domain.getAttribute('includeSubdomains'),
      })).sort((a, b) => a.name.localeCompare(b.name)),
    })), [{
      cleartextTrafficPermitted: 'true',
      domains: ['127.0.0.1', 'localhost', '::1'].sort((a, b) => a.localeCompare(b)).map(name => ({ name, includeSubdomains: 'false' })),
    }])
    const plugin = join(main, 'java/com/processone/fluux/keyboard/KeyboardInsetsPlugin.kt')
    const sourcePlugin = readFileSync(new URL('../apps/fluux/src-tauri/mobile/android/KeyboardInsetsPlugin.kt', import.meta.url))
    assert.deepEqual(readFileSync(plugin), sourcePlugin)
    prepareAndroid(project)
    assert.equal(readFileSync(manifest, 'utf8'), first)
    assert.ok(parseXml(readFileSync(policyPath, 'utf8')).documentElement.isEqualNode(policy.documentElement))
    assert.deepEqual(readFileSync(plugin), sourcePlugin)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
