#!/usr/bin/env node
//
// Stop a browser gate whose node_modules does not match package-lock.json.
//
// A working copy can hold an install made for another lockfile: a checkout moved
// forward by a pull or a rebase without `npm ci`, or a node_modules folder cloned
// or linked from another checkout. The browser suites then build the demo with
// whatever vite, rolldown and Babel happen to be installed, and run under whatever
// Playwright is installed, while the lockfile, CI and anyone reading the result
// assume the locked versions. Nothing fails loudly: the build succeeds, and the
// suites pass or fail for reasons that are not in the change under test.
//
// The comparison is entry by entry, against what npm itself would install:
//
//   - every locked package path holds the locked name and version. An optional
//     package may be absent: npm skips those built for another platform, and an
//     optional install that fails does not fail `npm ci`;
//   - every workspace link is still a link, and resolves;
//   - every installed package appears in the lockfile. A leftover nested copy is
//     not harmless: Node resolves it before the hoisted version the lockfile chose.
//
// It reads package.json files only: no npm, no network, well under a second.
// Every Playwright config under e2e/ runs it before anything else (through
// e2e/harness/installGuard.ts), and so does `npm run build:e2e`.
//
// Usage:
//   node scripts/check-install-lock.mjs [checkout]
//
// The checkout defaults to the one holding this script. Exits 1, explaining what
// differs and how to reinstall, when the install does not match.
//
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG = '[check-install-lock]'

/** How many differences the message lists before summarising the rest. */
const LISTED_DIFFERENCES = 12

/** A lockfile key that names an installed package, rather than the root or a workspace source. */
function isInstallPath(key) {
  return key.startsWith('node_modules/') || key.includes('/node_modules/')
}

/** The package name a lockfile key installs: the path after its last `node_modules/`. */
function nameFromKey(key) {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

function lstatOrNull(path) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function listOrEmpty(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function resolves(path) {
  try {
    realpathSync(path)
    return true
  } catch {
    return false
  }
}

function linkTarget(path) {
  try {
    return readlinkSync(path)
  } catch {
    return '?'
  }
}

/**
 * Compare the install under `root` with its package-lock.json.
 *
 * @param {string} root - The checkout holding package-lock.json and node_modules.
 * @returns {{ problem: string | null, lockUnreadable: boolean, linkedTo: string | null, differences: Array<{ path: string, locked: string, installed: string }>, entries: number }}
 *   `problem` names a state the comparison cannot start from (no readable lockfile, no
 *   install), and `lockUnreadable` says whether the lockfile is the cause; `linkedTo` is
 *   where node_modules points when it is a link; `differences` lists every package path
 *   whose installed state does not match the lockfile, sorted by path.
 */
export function findInstallDrift(root) {
  const result = { problem: null, lockUnreadable: false, linkedTo: null, differences: [], entries: 0 }

  let lock
  try {
    lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  } catch (error) {
    result.problem = `package-lock.json could not be read (${error.code ?? error.message}), so the install cannot be checked.`
    result.lockUnreadable = true
    return result
  }
  const packages = lock.packages
  if (!packages || typeof packages !== 'object') {
    result.problem = 'package-lock.json has no "packages" map, so the install cannot be checked; npm 7 or later writes one.'
    result.lockUnreadable = true
    return result
  }

  const nodeModules = join(root, 'node_modules')
  const nodeModulesStat = lstatOrNull(nodeModules)
  if (!nodeModulesStat) {
    result.problem = 'node_modules is missing: the dependencies are not installed.'
    return result
  }
  if (nodeModulesStat.isSymbolicLink()) {
    try {
      result.linkedTo = realpathSync(nodeModules)
    } catch {
      result.linkedTo = linkTarget(nodeModules)
      result.problem = `node_modules is a link to ${result.linkedTo}, which does not exist.`
      return result
    }
  }

  const differences = result.differences
  const workspaces = []

  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue
    if (!isInstallPath(key)) {
      workspaces.push(key)
      continue
    }
    result.entries += 1
    const path = join(root, key)
    const stat = lstatOrNull(path)

    if (entry.link) {
      // Where the link points is scripts/check-sdk-link.mjs's concern; it must exist and resolve.
      const locked = `link to ${entry.resolved}`
      if (!stat) differences.push({ path: key, locked, installed: 'not installed' })
      else if (!stat.isSymbolicLink()) differences.push({ path: key, locked, installed: 'a folder' })
      else if (!resolves(path)) differences.push({ path: key, locked, installed: `link to ${linkTarget(path)}, which does not resolve` })
      continue
    }

    if (!stat) {
      if (!entry.optional) differences.push({ path: key, locked: entry.version ?? '?', installed: 'not installed' })
      continue
    }
    if (stat.isSymbolicLink()) {
      differences.push({ path: key, locked: entry.version ?? '?', installed: `link to ${linkTarget(path)}` })
      continue
    }
    const manifest = readManifest(path)
    if (!manifest) {
      differences.push({ path: key, locked: entry.version ?? '?', installed: 'no readable package.json' })
      continue
    }
    const lockedName = entry.name ?? nameFromKey(key)
    if (manifest.name !== lockedName) {
      differences.push({ path: key, locked: `${lockedName} ${entry.version}`, installed: `${manifest.name} ${manifest.version}` })
    } else if (entry.version !== undefined && manifest.version !== entry.version) {
      differences.push({ path: key, locked: entry.version, installed: manifest.version ?? '?' })
    }
  }

  // Installed packages the lockfile does not know. Walk each node_modules folder npm
  // owns, descending only into packages the lockfile lists: an unknown package is
  // reported once, not together with everything nested inside it.
  const visit = key => {
    const path = join(root, key)
    const stat = lstatOrNull(path)
    if (!stat) return
    if (!Object.hasOwn(packages, key)) {
      if (stat.isSymbolicLink()) {
        differences.push({ path: key, locked: 'not in the lockfile', installed: `link to ${linkTarget(path)}` })
      } else {
        const manifest = readManifest(path)
        // A folder without package.json is not a package Node would resolve.
        if (manifest) differences.push({ path: key, locked: 'not in the lockfile', installed: manifest.version ?? '?' })
      }
      return
    }
    if (stat.isDirectory()) walk(`${key}/node_modules`)
  }
  const walk = folder => {
    for (const name of listOrEmpty(join(root, folder))) {
      // .bin, .package-lock.json and tool caches such as .vite are not packages.
      if (name.startsWith('.')) continue
      if (name.startsWith('@')) {
        for (const scoped of listOrEmpty(join(root, folder, name))) {
          if (!scoped.startsWith('.')) visit(`${folder}/${name}/${scoped}`)
        }
      } else {
        visit(`${folder}/${name}`)
      }
    }
  }
  walk('node_modules')
  for (const workspace of workspaces) walk(`${workspace}/node_modules`)

  differences.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return result
}

/**
 * Explain a failed comparison: what differs, and how to get an install that matches.
 *
 * @param {ReturnType<typeof findInstallDrift>} result - What findInstallDrift returned.
 * @param {string} root - The checkout the comparison read.
 * @returns {string} The message, several lines, without a trailing newline.
 */
export function describeInstallDrift(result, root) {
  const lines = []
  if (result.problem) {
    lines.push(`${TAG} ${result.problem}`)
  } else {
    lines.push(`${TAG} node_modules does not match package-lock.json: the install is stale.`)
    const count = result.differences.length
    lines.push(`  ${count} package ${count === 1 ? 'path differs' : 'paths differ'} from the lockfile:`)
    const shown = result.differences.slice(0, LISTED_DIFFERENCES)
    const width = Math.max(...shown.map(d => d.path.length))
    for (const d of shown) {
      lines.push(`    ${d.path.padEnd(width)}  locked: ${d.locked}, installed: ${d.installed}`)
    }
    if (count > shown.length) lines.push(`    ... and ${count - shown.length} more`)
  }
  lines.push('  Browser gates build and run only against the dependencies package-lock.json locks.')
  if (result.lockUnreadable) {
    lines.push('  Restore package-lock.json from the repository, then install the locked dependencies:')
  } else if (result.linkedTo) {
    lines.push(`  node_modules here is a link to ${result.linkedTo},`)
    lines.push('  an install made for another checkout. Remove the link itself (not the folder it')
    lines.push('  points to), then install this checkout\'s own dependencies:')
  } else {
    lines.push('  Install the locked dependencies, then start the gate again:')
  }
  lines.push(`    cd ${JSON.stringify(root)} && npm ci`)
  return lines.join('\n')
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (process.argv[1] && invokedDirectly()) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
  const result = findInstallDrift(root)
  if (result.problem || result.differences.length > 0) {
    console.error(`\n${describeInstallDrift(result, root)}\n`)
    process.exit(1)
  }
  console.log(`${TAG} node_modules matches package-lock.json (${result.entries} locked package paths).`)
}
