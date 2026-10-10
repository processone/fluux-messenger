import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withGeneratedFilesPreserved } from '../apps/fluux/scripts/ios-generated-files.mjs'

function fixture(t, contents) {
  const appDir = mkdtempSync(join(tmpdir(), 'fluux-ios-generated-'))
  t.after(() => rmSync(appDir, { recursive: true, force: true }))
  const manifests = join(appDir, 'src-tauri/gen/schemas/acl-manifests.json')
  if (contents !== undefined) {
    mkdirSync(join(appDir, 'src-tauri/gen/schemas'), { recursive: true })
    writeFileSync(manifests, contents)
  }
  return { appDir, manifests }
}

test('restores the capability manifests an iOS build rewrote', (t) => {
  const { appDir, manifests } = fixture(t, '{"desktop":true}')
  const result = withGeneratedFilesPreserved(appDir, () => {
    writeFileSync(manifests, '{"ios":true}')
    return 'built'
  })
  assert.equal(result, 'built')
  assert.equal(readFileSync(manifests, 'utf8'), '{"desktop":true}')
})

test('restores the capability manifests when the build fails', (t) => {
  const { appDir, manifests } = fixture(t, '{"desktop":true}')
  assert.throws(() => withGeneratedFilesPreserved(appDir, () => {
    writeFileSync(manifests, '{"ios":true}')
    throw new Error('build failed')
  }), /build failed/)
  assert.equal(readFileSync(manifests, 'utf8'), '{"desktop":true}')
})

test('leaves capability manifests a build creates in a checkout that had none', (t) => {
  const { appDir, manifests } = fixture(t)
  withGeneratedFilesPreserved(appDir, () => {
    mkdirSync(join(appDir, 'src-tauri/gen/schemas'), { recursive: true })
    writeFileSync(manifests, '{"ios":true}')
  })
  assert.ok(existsSync(manifests))
})
