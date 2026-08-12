import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Stores sit BELOW core in the SDK's dependency order.
 *
 * A store may name core's domain types; it must never end up in an import cycle
 * with core. When it does, no protocol module can be typechecked or reasoned
 * about without the whole state layer coming with it, and the package can no
 * longer describe its own state surface without naming its state library.
 *
 * The ESLint `no-restricted-imports` rule in `eslint.config.js` blocks the easy
 * way back in (a store importing the `../core` barrel, which re-exports
 * XMPPClient). This test covers the rest: a direct import of a core module that
 * imports stores back, however long the path between them.
 *
 * When this fails, the reported cycle names the modules; break the edge that
 * points from a store UP into core, not the one pointing down.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (!path.endsWith('.ts') && !path.endsWith('.tsx')) return []
    // Tests, helpers and mock factories are not part of the build graph.
    if (/\.test\.tsx?$/.test(path) || /testHelpers|test-utils/.test(path)) return []
    return [path]
  })
}

const files = sourceFiles(SRC)
const known = new Set(files)

/** Resolve a relative specifier the way the bundler does: file, then index. */
function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(from), specifier)
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'), base].find(
    candidate => known.has(candidate)
  )
}

function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
    const edges = specifiers
      .map(match => resolveImport(file, match[1]))
      .filter((target): target is string => target !== undefined && target !== file)
    graph.set(file, [...new Set(edges)])
  }
  return graph
}

/** Tarjan, iterative: the graph is ~800 modules deep enough to blow the stack. */
function stronglyConnectedComponents(graph: Map<string, string[]>): string[][] {
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

describe('stores layering', () => {
  const components = stronglyConnectedComponents(buildGraph())

  it('sees the whole SDK source graph', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it('keeps no store in an import cycle with core', () => {
    const mixed = components
      .filter(component => component.length > 1)
      .map(component => component.map(file => relative(SRC, file)).sort())
      .filter(
        component =>
          component.some(file => file.startsWith('stores/')) &&
          component.some(file => file.startsWith('core/'))
      )

    expect(mixed).toEqual([])
  })
})
