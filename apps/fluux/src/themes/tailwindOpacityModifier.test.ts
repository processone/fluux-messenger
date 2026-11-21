// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import config, { alphaVar } from '../../tailwind.config.js'

// Theme colours are CSS variables. Tailwind drops an opacity modifier it cannot
// apply without a word, so bg-fluux-brand/20 once compiled to no rule at all and
// the element drew no tint. Compile every such class the app uses and require a
// rule for each.

const SRC = join(process.cwd(), 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(tsx?|jsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

const MODIFIED_CLASS = /[\w:[\]&>=.-]*fluux-[a-z0-9-]+\/(?:\d+|\[[^\]\s]+\])/g

function opacityModifiedClasses(): string[] {
  const found = new Set<string>()
  for (const file of sourceFiles(SRC)) {
    for (const match of readFileSync(file, 'utf-8').matchAll(MODIFIED_CLASS)) {
      found.add(match[0])
    }
  }
  return [...found].sort()
}

// True when the class compiles to a declaration that does more than restate the
// bare variable: a missing rule and a rule that ignores the modifier both fail.
async function appliesOpacity(cls: string): Promise<boolean> {
  const result = await postcss([
    tailwindcss({ ...config, content: [{ raw: cls, extension: 'html' }], corePlugins: { preflight: false } }),
  ]).process('@tailwind utilities;', { from: undefined })
  let applied = false
  result.root.walkDecls((decl) => {
    const value = decl.value.trim()
    if (value.includes('--fluux-') && !/^var\(--fluux-[a-z0-9-]+\)$/.test(value)) applied = true
  })
  return applied
}

describe('opacity modifiers on theme colours', () => {
  const classes = opacityModifiedClasses()

  it('finds the classes it guards', () => {
    expect(classes.length).toBeGreaterThan(50)
  })

  it('compiles every fluux-*/NN class to a translucent colour', async () => {
    const results = await Promise.all(classes.map(async (cls) => [cls, await appliesOpacity(cls)] as const))
    expect(results.filter(([, ok]) => !ok).map(([cls]) => cls)).toEqual([])
  }, 60_000)

  it('detects a modifier that compiles to nothing', async () => {
    // Off the opacity scale: Tailwind emits nothing, which the check above must catch.
    expect(await appliesOpacity('bg-fluux-brand/33')).toBe(false)
  }, 60_000)

  it('keeps the bare variable when no modifier is given', () => {
    const brand = alphaVar('--fluux-bg-accent')
    expect(brand({})).toBe('var(--fluux-bg-accent)')
    expect(brand({ opacityVariable: '--tw-bg-opacity', opacityValue: 'var(--tw-bg-opacity, 1)' })).toBe(
      'var(--fluux-bg-accent)',
    )
    expect(brand({ opacityValue: '0.2' })).toBe(
      'color-mix(in srgb, var(--fluux-bg-accent) calc(0.2 * 100%), transparent)',
    )
  })
})
