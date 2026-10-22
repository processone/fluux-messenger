import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const app = fileURLToPath(new URL('../apps/fluux/', import.meta.url))
const config = JSON.parse(readFileSync(join(app, 'src-tauri/tauri.conf.json')))
const template = readFileSync(join(app, 'src-tauri/mobile/ios/project.yml'), 'utf8')

// Intent: the captain's iPhone share must resolve to Fluux, not a missing URL handler.
// Exercise XcodeGen's real plist output; a Tauri plugin's previous plist edit must survive regeneration.
test('regenerated app registers the scheme requested by its share extension', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-share-schemes-'))
  try {
    // Use the production app's complete info block. The native shell/Rust build is irrelevant here.
    const info = template.slice(template.indexOf('    info:\n'), template.indexOf('    entitlements:\n'))
      .replaceAll('{{app.name}}', 'fluux')
      .replaceAll('{{app.identifier}}', config.identifier)
      .replaceAll('{{apple.bundle-version-short}}', config.version)
      .replaceAll('{{apple.bundle-version}}', '1')
      .replace(/        {{~#each apple\.plist-pairs}}[^]*?{{\/each}}\n/, '')
    assert.ok(!info.includes('{{'), 'The fixture must render every app info field')
    // Simulate an existing plist previously updated by the deep-link plugin.
    const plist = join(scratch, 'fluux_iOS/Info.plist')
    mkdirSync(join(scratch, 'fluux_iOS'))
    const expectedSchemes = config.plugins['deep-link'].mobile.filter(domain => !domain.appLink).flatMap(domain => domain.scheme)
    writeFileSync(plist, JSON.stringify({ CFBundleURLTypes: [{ CFBundleURLSchemes: expectedSchemes }] }))
    execFileSync('plutil', ['-convert', 'xml1', plist])
    writeFileSync(join(scratch, 'project.yml'), `name: ShareSchemeCheck\ntargets:\n  fluux_iOS:\n    type: application\n    platform: iOS\n    settings:\n      base:\n        PRODUCT_BUNDLE_IDENTIFIER: ${config.identifier}\n${info}`)
    execFileSync('xcodegen', ['generate', '--spec', join(scratch, 'project.yml')], { cwd: scratch, timeout: 120000 })
    const generated = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist]))
    const schemes = (generated.CFBundleURLTypes ?? []).flatMap(type => type.CFBundleURLSchemes ?? [])
    for (const scheme of expectedSchemes) assert.ok(schemes.includes(scheme), `Generated app is missing ${scheme}`)
    assert.ok(schemes.includes(generated.FluuxAppScheme), 'The containing app must handle its share link')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
