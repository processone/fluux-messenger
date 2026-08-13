#!/usr/bin/env node
//
// Typecheck the code examples inside the SDK's JSDoc.
//
// An `@example` block is the first thing a reader copies, and it is the one
// part of the API that no compiler looks at: `tsc` sees a comment. So when a
// signature changes, the prose around it goes stale silently and keeps
// teaching a call that no longer exists. This extracts every fenced TypeScript
// block from the SDK's doc comments and compiles it against the real source.
//
// Two properties this file must keep:
//
//   1. One compiler pass. Every snippet becomes a file in one temporary
//      project, typechecked in a single `tsc` invocation, so the gate stays
//      cheap enough to sit inside `npm run typecheck`.
//
//   2. Errors reported at the doc comment, not at the generated file. A
//      failure has to point the author at the line they can edit.
//
// Snippets are compiled as modules against `PRELUDE` below. A snippet that
// needs more context than the prelude offers should declare it inline: that
// makes the example self-contained for a reader too, which is the point.
//
// Usage:
//   node scripts/check-jsdoc-examples.mjs [--list]
//
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SDK_ROOT = join(REPO_ROOT, 'packages/fluux-sdk')
const SCAN_ROOT = join(SDK_ROOT, 'src')

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage'])

/** Fence languages that carry compilable TypeScript. */
const CHECKED_LANGUAGES = new Set(['typescript', 'ts', 'tsx'])

/**
 * Fence modifier opting a snippet out of compilation: ```tsx fragment.
 *
 * For snippets that show where something goes rather than what runs — bare
 * JSX placed inside an app that is not shown. Compiling those would mean
 * wrapping them in a component and inventing the surrounding app, which buys
 * a green check by making the documentation worse. Anything that is meant to
 * be copied is not a fragment.
 */
const FRAGMENT_MODIFIER = 'fragment'

/**
 * What every snippet may assume is in scope.
 *
 * A doc example is read on the API page of the thing it documents, so it opens
 * on the call rather than on an import block. To keep them that way while still
 * compiling them, the package's own public exports are put in scope, read from
 * the barrel so the list cannot drift from what is actually exported.
 *
 * `client` is declared because an example of a client method cannot show the
 * method without one, and constructing and connecting a client would bury the
 * line the example is about.
 */
function buildPrelude() {
  const barrel = readFileSync(join(SDK_ROOT, 'src/index.ts'), 'utf8')
  const values = new Set()
  const types = new Set()
  // The barrel is curated and explicit: every line names what it re-exports.
  const clause = /export\s+(type\s+)?\{([^}]*)\}\s*from/g
  let m
  while ((m = clause.exec(barrel)) !== null) {
    const typeOnlyClause = Boolean(m[1])
    for (const raw of m[2].split(',')) {
      // `export { flush as flushPersistentStorage }`: the alias is the name a
      // consumer can import, so it is the one the prelude must use.
      const aliased = raw.trim().match(/\s+as\s+([A-Za-z_$][\w$]*)$/)
      const name = aliased ? aliased[1] : raw.trim()
      if (!name) continue
      const isType = typeOnlyClause || raw.trim().startsWith('type ')
      const clean = name.replace(/^type\s+/, '')
      if (isType) types.add(clean)
      else values.add(clean)
    }
  }
  return { values, types }
}

const { values: SDK_VALUES, types: SDK_TYPES } = buildPrelude()

/** Names a snippet declares itself, which must not be shadowed by the prelude. */
function declaredIn(code) {
  const names = new Set()
  for (const m of code.matchAll(/\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1])
  }
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').replace(/\s+as\s+.*$/, '')
      if (name) names.add(name)
    }
  }
  return names
}

function preludeFor(code) {
  const own = declaredIn(code)
  const values = [...SDK_VALUES].filter((n) => !own.has(n))
  const types = [...SDK_TYPES].filter((n) => !own.has(n))
  const lines = []
  if (values.length) lines.push(`import { ${values.join(', ')} } from '@fluux/sdk'`)
  if (types.length) lines.push(`import type { ${types.join(', ')} } from '@fluux/sdk'`)
  // React examples assume React, the way any reader of a hook page does.
  const react = ['useState', 'useEffect', 'useCallback', 'useMemo', 'useRef'].filter((n) => !own.has(n))
  if (react.length) lines.push(`import { ${react.join(', ')} } from 'react'`)
  if (!own.has('XMPPClient')) lines.push("import { XMPPClient } from '@fluux/sdk/core'")
  if (!own.has('client')) lines.push('declare const client: XMPPClient')
  lines.push('export {}')
  return lines.join('\n') + '\n'
}

/**
 * Extract fenced code blocks from the JSDoc comments of one source file.
 *
 * @returns Blocks with the 1-based line of their opening fence.
 */
export function extractExamples(source) {
  const blocks = []
  const docComment = /\/\*\*[\s\S]*?\*\//g
  let comment
  while ((comment = docComment.exec(source)) !== null) {
    const commentStart = comment.index
    const lines = comment[0].split('\n')
    let inFence = false
    let language = ''
    let modifier = ''
    let body = []
    let fenceLine = 0
    for (let i = 0; i < lines.length; i++) {
      // Doc comments carry a leading ` * `; the code is what follows it.
      const text = lines[i].replace(/^\s*\*ᅟ?\s?/, '').replace(/^\s*\/\*\*\s?/, '')
      const fence = text.match(/^```(\w*)(?:\s+(\w+))?\s*$/)
      if (fence) {
        if (!inFence) {
          inFence = true
          language = fence[1]
          modifier = fence[2] ?? ''
          body = []
          fenceLine = source.slice(0, commentStart).split('\n').length + i
        } else {
          if (CHECKED_LANGUAGES.has(language)) {
            blocks.push({
              language,
              code: body.join('\n'),
              line: fenceLine,
              fragment: modifier === FRAGMENT_MODIFIER,
            })
          }
          inFence = false
        }
        continue
      }
      if (inFence) body.push(text)
    }
  }
  return blocks
}

function sourceFiles(root) {
  const found = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry)) found.push(...sourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    if (/\.test\.tsx?$/.test(entry) || /\.testHelpers\.ts$/.test(entry)) continue
    found.push(full)
  }
  return found
}

/**
 * Rewrite a snippet's relative imports so they still point at what they named.
 *
 * `import { x } from './sibling'` in a doc comment means the sibling of the
 * file being documented. The snippet is compiled elsewhere, so the harness
 * re-anchors the specifier rather than asking authors to write paths that only
 * make sense to the checker.
 */
function reanchorRelativeImports(code, sourceDir, generatedDir) {
  const prefix = relative(generatedDir, sourceDir).split(sep).join('/')
  return code.replace(/(\bfrom\s*['"])(\.\.?\/[^'"]*)(['"])/g, (_all, open, spec, close) => {
    const resolved = `${prefix}/${spec}`.replace(/\/\.\//g, '/')
    return open + resolved + close
  })
}

function collect() {
  const collected = []
  for (const file of sourceFiles(SCAN_ROOT)) {
    for (const block of extractExamples(readFileSync(file, 'utf8'))) {
      collected.push({ ...block, file: relative(REPO_ROOT, file), sourceDir: dirname(file) })
    }
  }
  return collected
}

function main() {
  const blocks = collect()
  if (process.argv.includes('--list')) {
    for (const b of blocks) console.log(`${b.file}:${b.line}  (${b.language}${b.fragment ? ' fragment' : ''})`)
    console.log(`\n${blocks.length} example(s)`)
    return 0
  }

  const compiled = blocks.filter((b) => !b.fragment)
  const fragments = blocks.length - compiled.length

  // Generated inside the package, not in the system temp directory: module
  // resolution has to reach `node_modules` for React and the Node types, and
  // it only walks up from where the files actually live.
  const dir = mkdtempSync(join(SDK_ROOT, '.jsdoc-examples-'))
  try {
    const index = new Map()
    compiled.forEach((block, i) => {
      const name = `example_${String(i).padStart(3, '0')}.${block.language === 'tsx' ? 'tsx' : 'ts'}`
      const prelude = preludeFor(block.code)
      index.set(name, { ...block, preludeLines: prelude.split('\n').length - 1 })
      const code = reanchorRelativeImports(block.code, block.sourceDir, dir)
      writeFileSync(join(dir, name), prelude + code + '\n')
    })
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          extends: join(SDK_ROOT, 'tsconfig.json'),
          exclude: [],
          // `types` and `typeRoots` are deliberately left to the inherited
          // config: the generated project sits inside the package, so ordinary
          // upward resolution finds the same type packages the package uses.
          compilerOptions: {
            noEmit: true,
            // Wide enough to hold both the generated snippets and the sources
            // they import; the inherited `./src` would exclude the snippets.
            rootDir: '..',
            baseUrl: '.',
            // Snippets import the package the way a reader would; the paths
            // resolve to source so the check runs without a build.
            paths: {
              '@fluux/sdk': [join(SDK_ROOT, 'src/index.ts')],
              '@fluux/sdk/core': [join(SDK_ROOT, 'src/core/index.ts')],
              '@fluux/sdk/xmpp': [join(SDK_ROOT, 'src/xmpp/index.ts')],
              '@fluux/sdk/react': [join(SDK_ROOT, 'src/react/index.ts')],
              '@fluux/sdk/stores': [join(SDK_ROOT, 'src/stores/index.ts')],
            },
          },
          // The package's ambient module declarations (`@xmpp/client`, `ltx`)
          // are not reachable from the snippets by import, so they are named.
          include: ['*.ts', '*.tsx', '../src/**/*.d.ts'],
        },
        null,
        2,
      ),
    )

    // Resolved rather than pathed: npm hoists typescript to the workspace root,
    // and which node_modules holds it is not this script's business.
    const tscBin = createRequire(import.meta.url).resolve('typescript/bin/tsc')
    // Run from the temporary project so diagnostics carry bare file names.
    const tsc = spawnSync(process.execPath, [tscBin, '--noEmit', '-p', 'tsconfig.json'], {
      encoding: 'utf8',
      cwd: dir,
    })
    const output = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`
    if (tsc.status === 0) {
      console.log(`JSDoc examples: ${compiled.length} compiled, ${fragments} marked as fragments.`)
      return 0
    }

    // Translate `example_007.ts(12,3): error ...` back to the doc comment.
    const failures = new Map()
    for (const line of output.split('\n')) {
      const m = line.match(/^(example_\d+\.tsx?)\((\d+),(\d+)\): (.*)$/)
      if (!m) continue
      const block = index.get(m[1])
      if (!block) continue
      const inBlock = Number(m[2]) - block.preludeLines
      const key = `${block.file}:${block.line}`
      if (!failures.has(key)) failures.set(key, [])
      failures.get(key).push(`      line ${inBlock} of the example: ${m[4]}`)
    }

    if (failures.size === 0) {
      console.error('\nThe example project failed to compile as a whole:\n')
      console.error(output)
      return 1
    }

    console.error(`\nJSDoc examples: ${failures.size} of ${compiled.length} do not compile.\n`)
    for (const [where, messages] of failures) {
      console.error(`  ${where}`)
      for (const message of messages) console.error(message)
    }
    console.error(
      '\nAn example is API documentation. Fix the call, or make the snippet' +
        '\nself-contained by declaring what it uses.\n',
    )
    return 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main())
}
