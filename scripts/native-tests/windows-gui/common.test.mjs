import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { hash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBuild, parseOptions } from './common.mjs'

const config = JSON.parse(await readFile(new URL('../../../apps/fluux/src-tauri/tauri.windows-gui.conf.json', import.meta.url), 'utf8'))
const devConfig = JSON.parse(await readFile(new URL('../../../apps/fluux/src-tauri/tauri.dev.conf.json', import.meta.url), 'utf8'))

test('build record admits matching bytes and rejects wrong identity, TLS features and digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fluux-build-record-'))
  try {
    const app = join(directory, 'native-executable')
    await copyFile(process.execPath, app)
    const record = {
      identity: config.identifier, features: config.build.features, bundled: false,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sha256: hash('sha256', await readFile(app)),
    }
    const save = value => writeFile(`${app}.windows-gui-build.json`, JSON.stringify(value))
    await save(record)
    assert.deepEqual(await checkBuild(app), record)
    await save({ ...record, identity: devConfig.identifier })
    await assert.rejects(checkBuild(app), /disposable Dev GUI identity/)
    await save({ ...record, features: devConfig.build.features })
    await assert.rejects(checkBuild(app))
    await save({ ...record, sha256: hash('sha256', await readFile(new URL('./common.mjs', import.meta.url))) })
    await assert.rejects(checkBuild(app), /Executable differs/)
  } finally { await rm(directory, { recursive: true }) }
})

test('WSL entry-point options reject missing, duplicate and unknown inputs', () => {
  const allowed = { '--workspace': 'path', '--evidence': 'path', '--fail-after-session': 'flag' }
  assert.deepEqual(parseOptions(['--workspace', 'C:\\Temp\\fluux-windows-gui-smoke', '--fail-after-session'], allowed), {
    '--workspace': 'C:\\Temp\\fluux-windows-gui-smoke', '--fail-after-session': true,
  })
  assert.throws(() => parseOptions(['--evidence'], allowed), /needs a value/)
  assert.throws(() => parseOptions(['--workspace', 'C:\\Temp', '--workspace', 'C:\\Temp'], allowed), /Duplicate/)
  assert.throws(() => parseOptions(['--inherited-profile', 'C:\\Temp'], allowed), /Unknown/)
})
