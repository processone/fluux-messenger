import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf-8')
const tw = readFileSync(join(process.cwd(), 'tailwind.config.js'), 'utf-8')

describe('motion tokens', () => {
  it('defines the duration and easing tokens in :root', () => {
    expect(css).toMatch(/--fluux-duration-fast:\s*150ms/)
    expect(css).toMatch(/--fluux-duration-base:\s*200ms/)
    expect(css).toMatch(/--fluux-duration-slow:\s*300ms/)
    expect(css).toMatch(/--fluux-ease-standard:\s*ease-out/)
    expect(css).toMatch(/--fluux-ease-emphasized:\s*cubic-bezier\(0\.32, 0\.72, 0, 1\)/)
    expect(css).toMatch(/--fluux-ease-spring:\s*cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/)
  })

  it('exposes the tokens as Tailwind utilities', () => {
    expect(tw).toMatch(/fast:\s*'var\(--fluux-duration-fast\)'/)
    expect(tw).toMatch(/base:\s*'var\(--fluux-duration-base\)'/)
    expect(tw).toMatch(/slow:\s*'var\(--fluux-duration-slow\)'/)
    expect(tw).toMatch(/standard:\s*'var\(--fluux-ease-standard\)'/)
    expect(tw).toMatch(/emphasized:\s*'var\(--fluux-ease-emphasized\)'/)
    expect(tw).toMatch(/spring:\s*'var\(--fluux-ease-spring\)'/)
  })

  it('migrates the drawer and bounce animations onto the easing/duration tokens', () => {
    // drawer keeps 220ms, adopts the emphasized easing token
    expect(css).toMatch(/\.animate-drawer-in\s*\{\s*animation:\s*drawer-in-end 220ms var\(--fluux-ease-emphasized\)/)
    // bounce migrates fully (0.3s = slow) onto tokens
    expect(css).toMatch(/\.bounce-top\s*\{\s*animation:\s*bounce-top var\(--fluux-duration-slow\) var\(--fluux-ease-standard\)/)
    // no bespoke bezier literal remains on the drawer shorthand
    expect(css).not.toMatch(/animation:\s*drawer-in-end 220ms cubic-bezier/)
  })
})

describe('component animations reference motion tokens', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8')

  it('MessageList send + FAB animations use tokens', () => {
    const f = read('src/components/conversation/MessageList.tsx')
    expect(f).toMatch(/message-send var\(--fluux-duration-slow\) var\(--fluux-ease-standard\)/)
    expect(f).toMatch(/fab-spring-in_0\.4s_var\(--fluux-ease-spring\)_forwards/)
  })

  it('Sidebar view-enter uses tokens', () => {
    expect(read('src/components/Sidebar.tsx')).toMatch(/sidebar-view-enter var\(--fluux-duration-fast\) var\(--fluux-ease-standard\)/)
  })

  it('ReactionBurst uses the standard easing token', () => {
    expect(read('src/components/conversation/ReactionBurst.tsx')).toMatch(/reaction-burst \$\{DURATION_MS\}ms var\(--fluux-ease-standard\)/)
  })
})
