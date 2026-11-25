import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export const identity = 'net.processone.fluux.dev.gui-test'
export const driverVersion = '2.0.5'
export const features = ['production-tls', 'windows-gui-test']
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`
export const encodedPowerShell = script => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]

export async function checkBuild(app) {
  const build = JSON.parse(await readFile(`${app}.windows-gui-build.json`, 'utf8'))
  assert.equal(build.identity, identity, 'Only the disposable Dev GUI identity is allowed')
  assert.deepEqual(build.features, features)
  assert.match(build.commit, /^[a-f0-9]{40}$/)
  assert.equal(build.sha256, sha256(await readFile(app)), 'Executable differs from its build record; rebuild')
  assert.equal(build.bundled, false)
  return build
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
