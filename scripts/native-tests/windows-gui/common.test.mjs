import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { hash } from 'node:crypto'
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBuild, cleanupProfiles, parseOptions } from './common.mjs'

const config = JSON.parse(await readFile(new URL('../../../apps/fluux/src-tauri/tauri.windows-gui.conf.json', import.meta.url), 'utf8'))
const devConfig = JSON.parse(await readFile(new URL('../../../apps/fluux/src-tauri/tauri.dev.conf.json', import.meta.url), 'utf8'))

test('build record binds bytes, reviewed commit, identity and TLS features', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fluux-build-record-'))
  try {
    const app = join(directory, 'native-executable')
    await copyFile(process.execPath, app)
    await chmod(app, 0o700)
    const record = {
      identity: config.identifier, features: config.build.features, bundled: false,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sha256: hash('sha256', await readFile(app)),
    }
    const save = value => writeFile(`${app}.windows-gui-build.json`, JSON.stringify(value))
    await save(record)
    assert.deepEqual(await checkBuild(app, record.commit), record)
    // The commit header retains its parent even in a shallow hosted checkout.
    const previousCommit = execFileSync('git', ['cat-file', '-p', 'HEAD'], { encoding: 'utf8' })
      .match(/^parent ([a-f0-9]{40})$/m)?.[1]
    assert.ok(previousCommit)
    await assert.rejects(checkBuild(app, previousCommit), /reviewed source commit/)
    await save({ ...record, identity: devConfig.identifier })
    await assert.rejects(checkBuild(app, record.commit), /disposable Dev GUI identity/)
    await save({ ...record, features: devConfig.build.features })
    await assert.rejects(checkBuild(app, record.commit))
    await save({ ...record, sha256: hash('sha256', await readFile(new URL('./common.mjs', import.meta.url))) })
    await assert.rejects(checkBuild(app, record.commit), /Executable differs/)
    await save(record)
    await appendFile(app, Buffer.from([0]))
    await assert.rejects(checkBuild(app, record.commit), /Executable differs/)
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

async function profiles(action) {
  const directory = await mkdtemp(join(tmpdir(), 'fluux-cleanup-'))
  const local = join(directory, 'Local', config.identifier)
  const roaming = join(directory, 'Roaming', config.identifier)
  const token = 'current-test-run'
  try {
    for (const path of [local, roaming]) {
      await mkdir(path, { recursive: true })
      await writeFile(join(path, '.gui-test-owner'), token)
    }
    await action({ local, roaming, token })
  } finally { await rm(directory, { recursive: true }) }
}

test('unconfirmed shutdown retains every profile without touching its marker', async () => {
  await profiles(async ({ local, roaming, token }) => {
    const result = await cleanupProfiles([local, roaming], token, false)
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.retained, [local, roaming])
    assert.equal(await readFile(join(local, '.gui-test-owner'), 'utf8'), token)
    assert.equal(await readFile(join(roaming, '.gui-test-owner'), 'utf8'), token)
  })
})

test('confirmed shutdown removes all independently owned profiles despite a foreign marker', async () => {
  await profiles(async ({ local, roaming, token }) => {
    await writeFile(join(roaming, '.gui-test-owner'), 'another-test-run')
    const result = await cleanupProfiles([local, roaming], token, true)
    assert.deepEqual(result.removed, [local])
    assert.deepEqual(result.retained, [roaming])
    assert.equal(result.errors.length, 1)
    await assert.rejects(readFile(join(local, '.gui-test-owner')), { code: 'ENOENT' })
    assert.equal(await readFile(join(roaming, '.gui-test-owner'), 'utf8'), 'another-test-run')
  })
})
