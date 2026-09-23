#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '@tauri-apps/cli'

const native = resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri')
const catalogPath = 'gen/apple/Assets.xcassets/AppIcon.appiconset'
const catalog = resolve(native, catalogPath)
if (!existsSync(resolve(catalog, 'Contents.json'))) {
  throw new Error('Initialize the Xcode project with npm run tauri:ios:init first.')
}

const style = process.env.VITE_FLUUX_ICON_STYLE === 'plain' ? 'plain' : 'hollow'
const source = resolve(native, 'icons/icon-variants', style, 'icon-source-maskable.svg')
const scratch = mkdtempSync(resolve(tmpdir(), 'fluux-ios-icons-'))
try {
  // Tauri locates mobile assets relative to the output directory's parent.
  // Expose only the Apple catalog so its all-platform icon command cannot
  // overwrite the committed desktop assets or an Android project's resources.
  const linkedCatalog = resolve(scratch, catalogPath)
  mkdirSync(dirname(linkedCatalog), { recursive: true })
  symlinkSync(catalog, linkedCatalog, 'dir')
  await run(['icon', source, '--output', resolve(scratch, 'icons')])
  console.log(`[ios-icons] applied "${style}" to the Xcode asset catalog`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
