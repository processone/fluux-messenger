#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withExtensionsUnder } from './ios-extension-identifiers.mjs'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configIdentifier = name => JSON.parse(readFileSync(join(appDir, 'src-tauri', name), 'utf8')).identifier

// Ctrl-C reaches `tauri` too; staying alive lets the extensions move back once it exits.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})

const pbxproj = join(appDir, 'src-tauri/gen/apple/fluux.xcodeproj/project.pbxproj')
const dev = withExtensionsUnder(
  pbxproj,
  configIdentifier('tauri.ios.conf.json'),
  configIdentifier('tauri.ios-demo.conf.json'),
  () => spawnSync(
    'tauri',
    ['ios', 'dev', '--config', 'src-tauri/tauri.ios-demo.conf.json', '--open', ...process.argv.slice(2)],
    { cwd: appDir, stdio: 'inherit' },
  ),
)
if (dev.error) throw dev.error
process.exit(dev.status ?? 1)
