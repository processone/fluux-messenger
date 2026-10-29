import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureProjectCurrent, isProjectCurrent, recordProjectInputs } from '../apps/fluux/scripts/ios-project-freshness.mjs'

function fixture(t) {
  const appDir = mkdtempSync(join(tmpdir(), 'fluux-ios-project-'))
  t.after(() => rmSync(appDir, { recursive: true, force: true }))
  const write = (path, contents) => {
    mkdirSync(join(appDir, path, '..'), { recursive: true })
    writeFileSync(join(appDir, path), contents)
  }
  write('src-tauri/mobile/ios/project.yml', [
    'targets:',
    '  Extension:',
    '    sources:',
    '      - path: ../../plugins/push/ios/Sources/Shared',
    '      - path: ../../mobile/ios/Service.swift',
    '      - path: {{app.name}}_iOS',
  ].join('\n'))
  write('src-tauri/tauri.conf.json', '{"version":"0.18.0"}')
  write('src-tauri/tauri.ios.conf.json', '{"identifier":"net.processone.fluux"}')
  write('src-tauri/plugins/push/ios/Sources/Shared/Store.swift', 'struct Store {}')
  write('src-tauri/mobile/ios/Service.swift', 'final class Service {}')
  write('src-tauri/gen/apple/fluux.xcodeproj/project.pbxproj', 'generated')
  return { appDir, write }
}

test('a recorded project stays current when only file contents change', t => {
  const { appDir, write } = fixture(t)
  recordProjectInputs(appDir)
  assert.equal(isProjectCurrent(appDir), true)
  write('src-tauri/plugins/push/ios/Sources/Shared/Store.swift', 'struct Store { let id = 1 }')
  assert.equal(isProjectCurrent(appDir), true)
})

test('a file added under a listed source directory makes the project stale', t => {
  const { appDir, write } = fixture(t)
  recordProjectInputs(appDir)
  write('src-tauri/plugins/push/ios/Sources/Shared/Badge.swift', 'enum Badge {}')
  assert.equal(isProjectCurrent(appDir), false)
})

test('a template, version or iOS config edit makes the project stale', t => {
  for (const [path, contents] of [
    ['src-tauri/mobile/ios/project.yml', 'targets: {}'],
    ['src-tauri/tauri.conf.json', '{"version":"0.18.1"}'],
    ['src-tauri/tauri.ios.conf.json', '{"identifier":"net.processone.other"}'],
  ]) {
    const { appDir, write } = fixture(t)
    recordProjectInputs(appDir)
    write(path, contents)
    assert.equal(isProjectCurrent(appDir), false, path)
  }
})

test('a missing project or record is not current', t => {
  const { appDir } = fixture(t)
  assert.equal(isProjectCurrent(appDir), false, 'never recorded')
  recordProjectInputs(appDir)
  rmSync(join(appDir, 'src-tauri/gen/apple/fluux.xcodeproj'), { recursive: true })
  assert.equal(isProjectCurrent(appDir), false, 'project removed')
})

test('only a stale project is regenerated', t => {
  const { appDir, write } = fixture(t)
  const calls = []
  const run = (command, args) => calls.push([command, ...args].join(' '))
  recordProjectInputs(appDir)
  ensureProjectCurrent(appDir, run)
  assert.deepEqual(calls, [])
  write('src-tauri/mobile/ios/NewFile.swift', 'enum Unlisted {}')
  ensureProjectCurrent(appDir, run)
  assert.deepEqual(calls, [], 'a file outside the listed sources does not affect the project')
  write('src-tauri/plugins/push/ios/Sources/Shared/Badge.swift', 'enum Badge {}')
  ensureProjectCurrent(appDir, run)
  assert.deepEqual(calls, ['npm run tauri:ios:init'])
})
