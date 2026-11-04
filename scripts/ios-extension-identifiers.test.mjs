import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { retargetExtensions, withExtensionsUnder } from '../apps/fluux/scripts/ios-extension-identifiers.mjs'

const project = (app, extensions) => [
  `PRODUCT_BUNDLE_IDENTIFIER = ${app};`,
  `PRODUCT_BUNDLE_IDENTIFIER = ${extensions}.share;`,
  `PRODUCT_BUNDLE_IDENTIFIER = ${extensions}.notification;`,
  `PRODUCT_BUNDLE_IDENTIFIER = ${extensions}.widgets;`,
].join('\n')

function fixture(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-ios-extensions-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'project.pbxproj')
  writeFileSync(path, contents)
  return path
}

test('moves only the extension identifiers', () => {
  assert.equal(
    retargetExtensions(project('net.processone.fluux.demo', 'net.processone.fluux'), 'net.processone.fluux', 'net.processone.fluux.demo'),
    project('net.processone.fluux.demo', 'net.processone.fluux.demo'),
  )
})

test('builds with the extensions under the build identifier, then moves them back', (t) => {
  const path = fixture(t, project('net.processone.fluux', 'net.processone.fluux'))
  const result = withExtensionsUnder(path, 'net.processone.fluux', 'net.processone.fluux.demo', () => {
    assert.equal(readFileSync(path, 'utf8'), project('net.processone.fluux', 'net.processone.fluux.demo'))
    // The build retargets the app target itself.
    writeFileSync(path, project('net.processone.fluux.demo', 'net.processone.fluux.demo'))
    return 'built'
  })
  assert.equal(result, 'built')
  assert.equal(readFileSync(path, 'utf8'), project('net.processone.fluux.demo', 'net.processone.fluux'))
})

test('moves the extensions back when the build throws', (t) => {
  const path = fixture(t, project('net.processone.fluux', 'net.processone.fluux'))
  assert.throws(() => withExtensionsUnder(path, 'net.processone.fluux', 'net.processone.fluux.demo', () => {
    throw new Error('build failed')
  }), /build failed/)
  assert.equal(readFileSync(path, 'utf8'), project('net.processone.fluux', 'net.processone.fluux'))
})

test('leaves the project alone for its own identifier', (t) => {
  const path = fixture(t, project('net.processone.fluux', 'net.processone.fluux'))
  withExtensionsUnder(path, 'net.processone.fluux', 'net.processone.fluux', () => {
    assert.equal(readFileSync(path, 'utf8'), project('net.processone.fluux', 'net.processone.fluux'))
  })
})

// FLM-418 review R3: a demo widget kept the production shared folder and link scheme.
test('builds the widget with the build identifier\'s shared group and link scheme, then restores them', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-ios-widget-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'app.xcodeproj'))
  mkdirSync(join(dir, 'FluuxWidgets'))
  const pbx = join(dir, 'app.xcodeproj', 'project.pbxproj')
  const plist = join(dir, 'FluuxWidgets', 'Info.plist')
  const entitlements = join(dir, 'FluuxWidgets', 'FluuxWidgets.entitlements')
  const info = (id) => `<dict>\n\t<key>FluuxShareGroup</key>\n\t<string>group.${id}.share</string>\n\t<key>FluuxAppScheme</key>\n\t<string>${id}</string>\n</dict>`
  const ent = (id) => `<array><string>group.${id}.share</string></array>`
  const prod = 'net.processone.fluux'
  const demo = 'net.processone.fluux.demo'
  writeFileSync(pbx, project(prod, prod))
  writeFileSync(plist, info(prod))
  writeFileSync(entitlements, ent(prod))
  withExtensionsUnder(pbx, prod, demo, () => {
    assert.equal(readFileSync(plist, 'utf8'), info(demo))
    assert.equal(readFileSync(entitlements, 'utf8'), ent(demo))
  })
  assert.equal(readFileSync(plist, 'utf8'), info(prod))
  assert.equal(readFileSync(entitlements, 'utf8'), ent(prod))
})
