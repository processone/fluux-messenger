import { readFileSync } from 'node:fs'
import TOML from '@iarna/toml'

const manifest = TOML.parse(readFileSync(new URL('./Cargo.toml', import.meta.url), 'utf8'))
const features = manifest.dependencies.tauri.features

if (features.includes('unstable')) {
  console.error('tauri/unstable must remain disabled for the single-webview focus path')
  process.exit(1)
}

console.log('tauri/unstable is disabled')
