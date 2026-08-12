/**
 * The SDK's own import graph, for layering tests.
 *
 * Layering is an invariant no single file can state: it is a property of how
 * the modules point at each other. These helpers read the real sources and
 * expose that shape so a test can assert on it, rather than trusting that a
 * lint rule covers every way back into a cycle.
 *
 * Test-only. Excluded from the graph it builds, along with every other test
 * file, because none of them are part of the build.
 *
 * @packageDocumentation
 * @module Core
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `packages/fluux-sdk/src`, resolved from this file's own location. */
export const SDK_SRC = dirname(fileURLToPath(import.meta.url))

/** Every module the bundler would see: sources only, no tests or helpers. */
export function sdkSourceFiles(dir: string = SDK_SRC): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sdkSourceFiles(path)
    if (!path.endsWith('.ts') && !path.endsWith('.tsx')) return []
    if (/\.test\.tsx?$/.test(path) || /testHelpers|test-utils/.test(path)) return []
    return [path]
  })
}

/** Resolve a relative specifier the way the bundler does: file, then index. */
function resolveImport(from: string, specifier: string, known: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(from), specifier)
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'), base].find(
    candidate => known.has(candidate)
  )
}

/**
 * Adjacency over relative imports.
 *
 * Type-only imports are edges too: they do not survive to runtime, but they are
 * what a reader and the typechecker have to follow, and they are how the core
 * became one mutually recursive component in the first place.
 */
export function buildImportGraph(files: string[] = sdkSourceFiles()): Map<string, string[]> {
  const known = new Set(files)
  const graph = new Map<string, string[]>()
  for (const file of files) {
    const specifiers = [
      ...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
    ]
    const edges = specifiers
      .map(match => resolveImport(file, match[1], known))
      .filter((target): target is string => target !== undefined && target !== file)
    graph.set(file, [...new Set(edges)])
  }
  return graph
}

/** Tarjan, iterative: the graph is deep enough to blow the call stack. */
export function stronglyConnectedComponents(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  for (const root of graph.keys()) {
    if (index.has(root)) continue
    const work: Array<{ node: string; edge: number }> = [{ node: root, edge: 0 }]

    while (work.length > 0) {
      const frame = work[work.length - 1]
      const { node } = frame

      if (frame.edge === 0) {
        index.set(node, counter)
        lowlink.set(node, counter)
        counter++
        stack.push(node)
        onStack.add(node)
      }

      const edges = graph.get(node) ?? []
      if (frame.edge < edges.length) {
        const next = edges[frame.edge]
        frame.edge++
        if (!index.has(next)) work.push({ node: next, edge: 0 })
        else if (onStack.has(next)) lowlink.set(node, Math.min(lowlink.get(node)!, index.get(next)!))
        continue
      }

      if (lowlink.get(node) === index.get(node)) {
        const component: string[] = []
        for (;;) {
          const member = stack.pop()!
          onStack.delete(member)
          component.push(member)
          if (member === node) break
        }
        components.push(component)
      }

      work.pop()
      const parent = work[work.length - 1]
      if (parent) {
        lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(node)!))
      }
    }
  }

  return components
}

/**
 * Every import cycle, as sorted `src`-relative paths. Single modules are not
 * cycles and are dropped.
 */
export function importCycles(): string[][] {
  return stronglyConnectedComponents(buildImportGraph())
    .filter(component => component.length > 1)
    .map(component => component.map(file => relative(SDK_SRC, file)).sort())
    .sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1))
}
