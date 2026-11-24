import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const manifest = fileURLToPath(new URL('../../apps/fluux/src-tauri/nse-openpgp/Cargo.toml', import.meta.url))
const output = execFileSync('cargo', [
  'build', '--locked', '--manifest-path', manifest, '--features', 'synthetic-lab',
  '--example', 'identity_oracle', '--message-format=json-render-diagnostics',
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 8 * 1024 * 1024 })

// Cargo reports the executable even when it is fresh or the target directory is overridden.
const executables = output.trim().split('\n')
  .map(line => JSON.parse(line))
  .filter(message => message.reason === 'compiler-artifact' && message.executable &&
    message.target.name === 'identity_oracle' && message.target.kind.includes('example'))
  .map(message => message.executable)
if (executables.length !== 1) {
  throw new Error(`Expected one notification identity oracle executable from Cargo, got ${executables.length}`)
}
console.log(executables[0])
