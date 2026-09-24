#!/usr/bin/env node
import { run } from '@tauri-apps/cli'

const args = process.argv.slice(2)
try {
  // Generated Xcode projects invoke this npm entrypoint in their pre-build
  // phase, bypassing the tauri:ios:* npm lifecycle hooks.
  if (args[0] === 'ios' && args[1] === 'xcode-script') {
    await import('./tauri-ios-icons.mjs')
  }
  await run(args, 'npm run tauri')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
