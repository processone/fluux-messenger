// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { getFocusableElements } from './focusable'

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('getFocusableElements', () => {
  it('returns focusable descendants in DOM order', () => {
    const root = mount(
      '<button>a</button><input /><a href="#">l</a>',
    )
    const els = getFocusableElements(root)
    expect(els.map((e) => e.tagName)).toEqual(['BUTTON', 'INPUT', 'A'])
  })

  it('excludes disabled and tabindex="-1" elements', () => {
    const root = mount(
      '<button disabled>a</button><button tabindex="-1">b</button><button>c</button>',
    )
    const els = getFocusableElements(root)
    expect(els).toHaveLength(1)
    expect(els[0].textContent).toBe('c')
  })
})
