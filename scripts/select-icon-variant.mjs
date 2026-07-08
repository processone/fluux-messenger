#!/usr/bin/env node
/**
 * Copy a built icon variant's assets over the live app-icon locations.
 * Variant is chosen by VITE_FLUUX_ICON_STYLE (default 'hollow'); 'plain' opts
 * into the glass bubble. Runs on predev / prebuild / pretauri:* so a build's
 * native + PWA + favicon icons match the login mark's variant.
 *
 * Pure file copy from committed dist trees — no rasterizer or git needed.
 */
import { cpSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const appRoot = resolve(repoRoot, 'apps/fluux')

const raw = process.env.VITE_FLUUX_ICON_STYLE
const style = raw === 'plain' ? 'plain' : 'hollow'
if (raw && raw !== 'plain' && raw !== 'hollow') {
  console.warn(`[icon-variant] unknown VITE_FLUUX_ICON_STYLE="${raw}"; using hollow`)
}

const dist = resolve(appRoot, 'src-tauri/icons/icon-variants', style, 'dist')
if (!existsSync(dist)) {
  console.error(
    `[icon-variant] missing generated assets for "${style}": ${dist}\n` +
    `Run: (cd apps/fluux/src-tauri/icons && ./generate.sh ${style})`,
  )
  process.exit(1)
}

// Merge dist/icons over the live icons dir (leaves generate.sh + icon-variants/
// intact) and dist/public over the live public dir.
cpSync(resolve(dist, 'icons'), resolve(appRoot, 'src-tauri/icons'), { recursive: true })
cpSync(resolve(dist, 'public'), resolve(appRoot, 'public'), { recursive: true })
console.log(`[icon-variant] applied "${style}" icon set (native + PWA + favicon)`)
