import { readFileSync, readdirSync } from 'node:fs'
import TOML from '@iarna/toml'

const manifest = TOML.parse(readFileSync(new URL('./Cargo.toml', import.meta.url), 'utf8'))
const dependencies = [manifest.dependencies, ...Object.values(manifest.target ?? {}).map(target => target.dependencies)]
const features = dependencies.flatMap(deps => deps?.tauri?.features ?? [])

if (features.includes('unstable')) {
  console.error('tauri/unstable must remain disabled for the single-webview focus path')
  process.exit(1)
}

// Released builds ship without Inspect Element. Debug builds (tauri dev) still get the web
// inspector from Tauri itself, and Shift + right-click opens the system menu in them.
if (features.includes('devtools')) {
  console.error('tauri/devtools must remain disabled so released builds drop Inspect Element')
  process.exit(1)
}
for (const name of readdirSync(new URL('./', import.meta.url)).filter(f => /^tauri(\..+)?\.conf\.json$/.test(f))) {
  const conf = JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'))
  if ((conf.app?.windows ?? []).some(w => w.devtools === true)) {
    console.error(`${name} enables window devtools, which ships Inspect Element in released builds`)
    process.exit(1)
  }
}

console.log('tauri/unstable and tauri/devtools are disabled')
