#!/usr/bin/env node
// Guard against a hijacked @fluux/sdk workspace symlink.
//
// Worktrees under .claude/worktrees/ (and sibling checkouts) share resolution
// through node_modules symlinks. A worktree dev session that repoints
// node_modules/@fluux/sdk at its own packages/fluux-sdk and forgets to restore
// it leaves the main build resolving the SDK from a foreign checkout — producing
// "separate declarations of private property" type errors from two XMPPClient
// module instances.
//
// Invariant: node_modules/@fluux/sdk must resolve to THIS checkout's
// packages/fluux-sdk or the MAIN repo's — never into a different worktree.
// When it points elsewhere we repair it to the main-repo package (the safe
// canonical target) and log loudly. Run automatically before build/dev/typecheck.

import { realpathSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const cwd = process.cwd()
const linkPath = join(cwd, 'node_modules', '@fluux', 'sdk')

// The main checkout is this dir, or — if we're inside a worktree — the parent
// before the worktrees segment. Sibling checkouts (no .claude/worktrees in the
// path) are their own main root.
const marker = '/.claude/worktrees/'
const idx = cwd.indexOf(marker)
const mainRoot = idx === -1 ? cwd : cwd.slice(0, idx)

const canonicalTarget = realpathOrNull(join(mainRoot, 'packages', 'fluux-sdk'))
const currentTarget = realpathOrNull(join(cwd, 'packages', 'fluux-sdk'))

function realpathOrNull(p) {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

// Nothing to guard before `npm install` has created the link.
let linkStat
try {
  linkStat = lstatSync(linkPath)
} catch {
  process.exit(0)
}

const actual = realpathOrNull(linkPath)
const acceptable = new Set([canonicalTarget, currentTarget].filter(Boolean))

if (actual && acceptable.has(actual)) {
  process.exit(0)
}

// Broken: dangling link, or points into a foreign checkout/worktree. Repair to
// the main-repo package.
if (!canonicalTarget) {
  console.error(
    `\n[check-sdk-link] node_modules/@fluux/sdk is misresolved and the main SDK package ` +
      `(${join(mainRoot, 'packages', 'fluux-sdk')}) was not found. Run \`npm install\`.\n`,
  )
  process.exit(1)
}

const repairTo = join(mainRoot, 'packages', 'fluux-sdk')
console.warn(
  `\n[check-sdk-link] @fluux/sdk was resolving to a foreign checkout:\n` +
    `    ${actual ?? '(dangling link)'}\n` +
    `  Repointing node_modules/@fluux/sdk -> ${repairTo}\n` +
    `  (A worktree dev session likely left it swapped. See docs on worktree SDK resolution.)\n`,
)

try {
  if (linkStat.isSymbolicLink() || linkStat.isFile()) {
    rmSync(linkPath)
  } else {
    rmSync(linkPath, { recursive: true, force: true })
  }
  symlinkSync(repairTo, linkPath)
} catch (err) {
  console.error(
    `[check-sdk-link] Failed to repair the link automatically: ${err.message}\n` +
      `  Fix manually:\n    rm -rf ${linkPath} && ln -s ${repairTo} ${linkPath}\n`,
  )
  process.exit(1)
}
