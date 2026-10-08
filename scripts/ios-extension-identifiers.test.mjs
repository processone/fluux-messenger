import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { retargetExtensions, withExtensionsUnder } from '../apps/fluux/scripts/ios-extension-identifiers.mjs'

const project = (app, extensions) => [
  `PRODUCT_BUNDLE_IDENTIFIER = ${app};`,
  `PRODUCT_BUNDLE_IDENTIFIER = ${extensions}.share;`,
  `PRODUCT_BUNDLE_IDENTIFIER = ${extensions}.notification;`,
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
