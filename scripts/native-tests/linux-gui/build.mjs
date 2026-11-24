import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux') throw new Error('The native GUI test build supports Linux only')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const appRoot = join(root, 'apps/fluux')
const app = join(appRoot, 'src-tauri/target/debug/fluux')
const config = {
  build: { features: ['production-tls'] },
  bundle: { createUpdaterArtifacts: false },
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
if (status) throw new Error('Commit the test setup before building its provenance-tracked executable')
for (const [cwd, args] of [
  [root, ['run', 'build:sdk']],
  [appRoot, ['run', 'tauri', '--', 'build', '--debug', '--no-bundle', '--config', 'src-tauri/tauri.dev.conf.json', '--config', JSON.stringify(config)]],
]) {
  const result = spawnSync('npm', args, {
    cwd, stdio: 'inherit', env: { ...process.env, FLUUX_ANOMALY: '1' },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const version = JSON.parse(await readFile(join(appRoot, 'src-tauri/tauri.conf.json'))).version
await writeFile(`${app}.linux-gui-build.json`, JSON.stringify({
  commit, version, identity: 'net.processone.fluux.dev', features: ['production-tls'],
  sha256: createHash('sha256').update(await readFile(app)).digest('hex'),
}, null, 2))
console.log(`Built unsigned Dev native GUI executable: ${app}`)
