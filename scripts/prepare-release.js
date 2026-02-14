#!/usr/bin/env node

/**
 * Release preparation script for Fluux Messenger
 *
 * Usage:
 *   npm run release:prepare 0.9.0
 *   npm run release:prepare 0.9.0 --tag   # Also creates git tag
 *
 * This script:
 * 1. Updates version in all package.json files
 * 2. Updates version in tauri.conf.json and Cargo.toml
 * 3. Generates CHANGELOG.md from changelog.ts (authoritative source)
 * 4. Optionally creates a git tag
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// Files containing version numbers
const VERSION_FILES = [
  'package.json',
  'apps/fluux/package.json',
  'packages/fluux-sdk/package.json',
]

const TAURI_CONF = 'apps/fluux/src-tauri/tauri.conf.json'
const TAURI_CARGO = 'apps/fluux/src-tauri/Cargo.toml'
const CHANGELOG_TS = 'apps/fluux/src/data/changelog.ts'
const CHANGELOG_MD = 'CHANGELOG.md'
const RELEASE_NOTES = 'RELEASE_NOTES.md'

// Parse arguments
const args = process.argv.slice(2)
const version = args.find(a => !a.startsWith('--'))
const shouldTag = args.includes('--tag')

if (!version) {
  console.error('Usage: npm run release:prepare <version> [--tag]')
  console.error('Example: npm run release:prepare 0.9.0')
  console.error('         npm run release:prepare 0.9.0 --tag')
  process.exit(1)
}

// Validate version format
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`Invalid version format: ${version}`)
  console.error('Expected format: X.Y.Z or X.Y.Z-suffix')
  process.exit(1)
}

console.log(`\nPreparing release v${version}\n`)

// 1. Update version in package.json files
console.log('Updating package.json files...')
for (const file of VERSION_FILES) {
  const filePath = path.join(ROOT, file)
  const pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  const oldVersion = pkg.version
  pkg.version = version
  fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`  ${file}: ${oldVersion} -> ${version}`)
}

// 2. Update tauri.conf.json
console.log('\nUpdating tauri.conf.json...')
const tauriPath = path.join(ROOT, TAURI_CONF)
const tauriConf = JSON.parse(fs.readFileSync(tauriPath, 'utf-8'))
const oldTauriVersion = tauriConf.version
tauriConf.version = version

// Update bundleVersion with short git hash
try {
  const gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  tauriConf.bundle.macOS.bundleVersion = gitHash
  console.log(`  version: ${oldTauriVersion} -> ${version}`)
  console.log(`  bundleVersion: ${gitHash}`)
} catch (e) {
  console.log(`  version: ${oldTauriVersion} -> ${version}`)
  console.log(`  bundleVersion: (unchanged, git not available)`)
}
fs.writeFileSync(tauriPath, JSON.stringify(tauriConf, null, 2) + '\n')

// 3. Update Cargo.toml version
console.log('\nUpdating Cargo.toml...')
const cargoPath = path.join(ROOT, TAURI_CARGO)
let cargoContent = fs.readFileSync(cargoPath, 'utf-8')
const cargoVersionMatch = cargoContent.match(/^version\s*=\s*"([^"]+)"/m)
const oldCargoVersion = cargoVersionMatch ? cargoVersionMatch[1] : 'unknown'
cargoContent = cargoContent.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`)
fs.writeFileSync(cargoPath, cargoContent)
console.log(`  version: ${oldCargoVersion} -> ${version}`)

// 4. Generate CHANGELOG.md from changelog.ts
console.log('\nGenerating CHANGELOG.md from changelog.ts...')
const changelogTsPath = path.join(ROOT, CHANGELOG_TS)
const changelogTsContent = fs.readFileSync(changelogTsPath, 'utf-8')

// Parse the changelog.ts file to extract entries
// Uses a state-machine approach to handle complex strings
function parseChangelogTs(content) {
  const entries = []

  // Find the array content after 'export const changelog'
  const arrayStart = content.indexOf('[', content.indexOf('export const changelog'))
  if (arrayStart === -1) return entries

  // Extract version/date pairs and their positions
  const versionRegex = /version:\s*'([^']+)'/g
  const dateRegex = /date:\s*'([^']+)'/g

  // Find all entry blocks by matching version patterns
  let versionMatch
  const versionPositions = []
  while ((versionMatch = versionRegex.exec(content)) !== null) {
    versionPositions.push({ version: versionMatch[1], index: versionMatch.index })
  }

  // For each version, find the corresponding date and sections
  for (let i = 0; i < versionPositions.length; i++) {
    const { version, index: versionIndex } = versionPositions[i]
    const nextVersionIndex = i < versionPositions.length - 1
      ? versionPositions[i + 1].index
      : content.length

    const entryContent = content.slice(versionIndex, nextVersionIndex)

    // Extract date
    const dateMatch = entryContent.match(/date:\s*'([^']+)'/)
    const date = dateMatch ? dateMatch[1] : ''

    // Extract sections
    const sections = []
    const sectionTypeRegex = /type:\s*'(\w+)'/g
    let typeMatch

    while ((typeMatch = sectionTypeRegex.exec(entryContent)) !== null) {
      const type = typeMatch[1]
      const typeIndex = typeMatch.index

      // Find items array after this type
      const itemsStart = entryContent.indexOf('items:', typeIndex)
      if (itemsStart === -1) continue

      const arrayOpen = entryContent.indexOf('[', itemsStart)
      if (arrayOpen === -1) continue

      // Find matching closing bracket
      let depth = 1
      let arrayClose = arrayOpen + 1
      while (depth > 0 && arrayClose < entryContent.length) {
        if (entryContent[arrayClose] === '[') depth++
        else if (entryContent[arrayClose] === ']') depth--
        arrayClose++
      }

      const itemsContent = entryContent.slice(arrayOpen + 1, arrayClose - 1)

      // Extract strings - handle escaped quotes
      const items = []
      let inString = false
      let currentItem = ''
      let escapeNext = false

      for (let j = 0; j < itemsContent.length; j++) {
        const char = itemsContent[j]

        if (escapeNext) {
          currentItem += char
          escapeNext = false
          continue
        }

        if (char === '\\') {
          escapeNext = true
          continue
        }

        if (char === "'" && !inString) {
          inString = true
          currentItem = ''
        } else if (char === "'" && inString) {
          inString = false
          if (currentItem.trim()) {
            items.push(currentItem)
          }
        } else if (inString) {
          currentItem += char
        }
      }

      if (items.length > 0) {
        sections.push({ type, items })
      }
    }

    entries.push({ version, date, sections })
  }

  return entries
}

const entries = parseChangelogTs(changelogTsContent)

if (entries.length === 0) {
  console.error('  Error: Could not parse changelog.ts')
  process.exit(1)
}

// Check if the new version (or its base version for prereleases) exists in changelog.ts
const hasNewVersion = entries.some(e => e.version === version || e.version === version.replace(/-.*$/, ''))
if (!hasNewVersion) {
  console.log(`  Warning: Version ${version} not found in changelog.ts`)
  console.log(`  Add the changelog entry to apps/fluux/src/data/changelog.ts first!`)
}

// Generate markdown
const sectionTitles = {
  added: 'Added',
  changed: 'Changed',
  fixed: 'Fixed',
  removed: 'Removed',
}

let markdown = `# Changelog

All notable changes to Fluux Messenger are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`

for (const entry of entries) {
  markdown += `## [${entry.version}] - ${entry.date}\n\n`

  for (const section of entry.sections) {
    const title = sectionTitles[section.type] || section.type
    markdown += `### ${title}\n\n`
    for (const item of section.items) {
      markdown += `- ${item}\n`
    }
    markdown += '\n'
  }
}

fs.writeFileSync(path.join(ROOT, CHANGELOG_MD), markdown)
console.log(`  Generated ${CHANGELOG_MD} with ${entries.length} releases`)

// 5. Generate RELEASE_NOTES.md (just the current version, for GitHub release body)
console.log('\nGenerating RELEASE_NOTES.md for auto-updater...')
// For prerelease versions (e.g. 0.13.2-beta.1), fall back to the base version (0.13.2)
// since changelog.ts uses the target release version, not the prerelease suffix
const baseVersion = version.replace(/-.*$/, '')
const currentEntry = entries.find(e => e.version === version) || entries.find(e => e.version === baseVersion)
if (currentEntry) {
  let releaseNotes = `## What's New in v${version}\n\n`

  for (const section of currentEntry.sections) {
    const title = sectionTitles[section.type] || section.type
    releaseNotes += `### ${title}\n\n`
    for (const item of section.items) {
      releaseNotes += `- ${item}\n`
    }
    releaseNotes += '\n'
  }

  releaseNotes += `---\n[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)\n`

  fs.writeFileSync(path.join(ROOT, RELEASE_NOTES), releaseNotes)
  console.log(`  Generated ${RELEASE_NOTES}`)
} else {
  console.log(`  Skipped (version ${version} not in changelog.ts)`)
}

// 6. Create git tag if requested
if (shouldTag) {
  console.log('\nCreating git tag...')
  try {
    execSync(`git tag -a v${version} -m "Release v${version}"`, { cwd: ROOT, stdio: 'inherit' })
    console.log(`  Created tag: v${version}`)
    console.log(`\n  To push: git push origin v${version}`)
  } catch (e) {
    console.error(`  Error creating tag: ${e.message}`)
  }
}

console.log('\n--- Release preparation complete ---\n')
console.log('Next steps:')
console.log('  1. Review the changes: git diff')
console.log('  2. Commit: git add -A && git commit -m "chore: bump version to ' + version + '"')
if (!shouldTag) {
  console.log('  3. Create tag: git tag -a v' + version + ' -m "Release v' + version + '"')
  console.log('  4. Push: git push origin main && git push origin v' + version)
} else {
  console.log('  3. Push: git push origin main && git push origin v' + version)
}
console.log('')
