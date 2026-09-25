import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareAndroid } from '../apps/fluux/scripts/tauri-android-prepare.mjs'

test('Android preparation permits loopback proxy traffic and system DNS access, idempotently', () => {
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
    assert.match(first, /android:networkSecurityConfig="@xml\/fluux_network_security_config"/)
    assert.match(first, /android.permission.ACCESS_NETWORK_STATE/)
    assert.match(first, /android:label="Fluux"/)
    assert.match(first, /android:usesCleartextTraffic="false"/)
    const policy = readFileSync(join(main, 'res/xml/fluux_network_security_config.xml'), 'utf8')
    assert.match(policy, /<base-config cleartextTrafficPermitted="false"/)
    assert.match(policy, /<domain-config cleartextTrafficPermitted="true">/)
    assert.match(policy, /<domain includeSubdomains="false">127\.0\.0\.1<\/domain>/)
    prepareAndroid(project)
    assert.equal(readFileSync(manifest, 'utf8'), first)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
