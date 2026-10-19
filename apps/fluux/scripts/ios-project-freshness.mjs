#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// `tauri ios init` renders the project.yml template through XcodeGen into a fixed list of
// sources. Editing the template, the iOS config, or adding a file under a directory the template
// lists leaves an existing generated project stale, and Xcode then fails on a missing symbol.
const TEMPLATE = 'src-tauri/mobile/ios/project.yml'
const CONFIG = 'src-tauri/tauri.ios.conf.json'
const GENERATED_DIR = 'src-tauri/gen/apple'
const PROJECT = `${GENERATED_DIR}/fluux.xcodeproj/project.pbxproj`
const STAMP = `${GENERATED_DIR}/.fluux-project-inputs`

function listFiles(path) {
  if (!existsSync(path)) return ['missing']
  if (!statSync(path).isDirectory()) return ['file']
  return readdirSync(path, { recursive: true })
    .filter(entry => !statSync(join(path, entry)).isDirectory())
    .map(String)
    .sort()
}

/** Digest of everything `tauri ios init` reads to decide the generated project's file list. */
export function projectInputsDigest(appDir) {
  const hash = createHash('sha256')
  for (const file of [TEMPLATE, CONFIG]) {
    const path = join(appDir, file)
    hash.update(`${file}\0${existsSync(path) ? readFileSync(path) : 'missing'}\0`)
  }
  const template = existsSync(join(appDir, TEMPLATE)) ? readFileSync(join(appDir, TEMPLATE), 'utf8') : ''
  // Template paths are relative to the generated directory; `../..` ones point at checked-in sources.
  const sources = [...template.matchAll(/^\s*-?\s*path:\s*['"]?(\.\.\/[^'"\s]+)/gm)].map(match => match[1])
  for (const source of [...new Set(sources)].sort()) {
    const path = resolve(appDir, GENERATED_DIR, source)
    hash.update(`${relative(appDir, path)}\0${listFiles(path).join('\n')}\0`)
  }
  return hash.digest('hex')
}

export function isProjectCurrent(appDir) {
  const stamp = join(appDir, STAMP)
  return existsSync(join(appDir, PROJECT)) && existsSync(stamp)
    && readFileSync(stamp, 'utf8').trim() === projectInputsDigest(appDir)
}

export function recordProjectInputs(appDir) {
  writeFileSync(join(appDir, STAMP), `${projectInputsDigest(appDir)}\n`)
}

/** Regenerates the Xcode project through `run` when it is missing or older than its inputs. */
export function ensureProjectCurrent(appDir, run) {
  if (isProjectCurrent(appDir)) return
  console.log('The iOS Xcode project is missing or out of date; running tauri:ios:init.')
  run('npm', ['run', 'tauri:ios:init'])
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--record') {
  recordProjectInputs(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
}
