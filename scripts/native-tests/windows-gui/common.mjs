import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const identity = 'net.processone.fluux.dev.gui-test'
export const driverVersion = '2.0.5'
export const features = ['production-tls', 'windows-gui-test']
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`
export const encodedPowerShell = script => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]

export async function checkBuild(app, expectedCommit) {
  const build = JSON.parse(await readFile(`${app}.windows-gui-build.json`, 'utf8'))
  assert.equal(build.identity, identity, 'Only the disposable Dev GUI identity is allowed')
  assert.deepEqual(build.features, features)
  assert.match(expectedCommit, /^[a-f0-9]{40}$/, 'Supply the reviewed source commit')
  assert.equal(build.commit, expectedCommit, 'Executable was not built from the reviewed source commit')
  assert.equal(build.sha256, sha256(await readFile(app)), 'Executable differs from its build record; rebuild')
  assert.equal(build.bundled, false)
  return build
}

export async function cleanupProfiles(owned, token, shutdownConfirmed) {
  const removed = []
  const errors = []
  for (const path of [...owned].reverse()) {
    try {
      assert.ok(shutdownConfirmed, 'Retaining profiles because owned-job shutdown was not confirmed')
      assert.equal(await readFile(join(path, '.gui-test-owner'), 'utf8'), token, 'Profile ownership changed')
      await rm(path, { recursive: true })
      removed.push(path)
    } catch (error) { errors.push({ path, error: error.message }) }
  }
  return { removed, retained: owned.filter(path => !removed.includes(path)), errors }
}

export function parseOptions(args, allowed) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    assert.ok(Object.hasOwn(allowed, key), `Unknown option: ${key}`)
    assert.ok(!Object.hasOwn(options, key), `Duplicate option: ${key}`)
    if (allowed[key] === 'flag') options[key] = true
    else {
      assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `${key} needs a value`)
      options[key] = args[++i]
    }
  }
  return options
}
