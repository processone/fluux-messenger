import { shareResources } from './mobile-share-resources.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function prepareAndroid(project) {
  const main = join(project, 'app/src/main')
  shareResources(main)
  const manifestPath = join(main, 'AndroidManifest.xml')
  let manifest = readFileSync(manifestPath, 'utf8')
  if (!/<application\b/.test(manifest)) throw new Error('Android manifest has no application')
  manifest = manifest.replace(/<application\b[^>]*>/, tag => {
    const clean = tag.replace(/\s+android:(?:networkSecurityConfig|usesCleartextTraffic)="[^"]*"/g, '')
    return clean.replace('<application', '<application android:networkSecurityConfig="@xml/fluux_network_security_config" android:usesCleartextTraffic="false"')
  })
  // Hickory reads the active network's DNS servers through ConnectivityManager.
  for (const permission of ['INTERNET', 'ACCESS_NETWORK_STATE']) {
    if (!manifest.includes(`android.permission.${permission}`)) {
      manifest = manifest.replace('</manifest>', `    <uses-permission android:name="android.permission.${permission}" />\n</manifest>`)
    }
  }
  if (!manifest.includes('com.processone.shareinbox.ReceiveShareActivity')) {
    manifest = manifest.replace('</application>', `
      <activity android:name="com.processone.shareinbox.ReceiveShareActivity" android:exported="true" android:excludeFromRecents="true">
        <intent-filter>
          <action android:name="android.intent.action.SEND" />
          <category android:name="android.intent.category.DEFAULT" />
          <data android:mimeType="*/*" />
        </intent-filter>
      </activity>
    </application>`)
  }
  const policyPath = join(main, 'res/xml/fluux_network_security_config.xml')
  mkdirSync(dirname(policyPath), { recursive: true })
  writeFileSync(policyPath, `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">::1</domain>
  </domain-config>
</network-security-config>
`)
  writeFileSync(manifestPath, manifest)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepareAndroid(fileURLToPath(new URL('../src-tauri/gen/android', import.meta.url)))
}
