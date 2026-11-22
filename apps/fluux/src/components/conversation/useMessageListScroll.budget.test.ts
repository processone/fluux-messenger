import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Intent (plan FLM-51, part D): the scroll hook keeps at most 8 effects and 15 refs, and the
 * contract document stays a rule table under 350 lines. These are the numbers the refactor
 * promised, kept as a gate so a new concern joins the commit plan instead of growing the hook.
 */

const here = import.meta.dirname
const hook = readFileSync(join(here, 'useMessageListScroll.ts'), 'utf8')
const contract = readFileSync(join(here, '../../../../../docs/2026-07-23-scroll-positioning-contract.md'), 'utf8')

const code = hook.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('scroll hook size budget', () => {
  it('declares at most 8 effects', () => {
    const effects = code.match(/\buse(Layout|Insertion)?Effect\(/g) ?? []
    expect(effects.length).toBeLessThanOrEqual(8)
  })

  it('declares at most 15 refs', () => {
    const refs = code.match(/\buseRef\b/g) ?? []
    expect(refs.length).toBeLessThanOrEqual(15)
  })

  it('keeps the contract document under 350 lines', () => {
    expect(contract.split('\n').length).toBeLessThan(350)
  })
})
