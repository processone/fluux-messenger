// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { render, act } from '@testing-library/react'
import { OwnGroupWidthRegistry, OwnGroupWidthProvider, useOwnGroupWidth } from './messageGroupWidth'

/**
 * jsdom reports offsetWidth as 0, so we drive the registry with a controllable
 * natural width per element. The registry sets `width: max-content` before
 * reading offsetWidth; our getter ignores style and returns the injected value,
 * which is exactly the "natural width" the flush wants to read.
 */
function memberWithWidth(width: number): HTMLElement & { __w: number } {
  const el = document.createElement('div') as unknown as HTMLElement & { __w: number }
  el.__w = width
  Object.defineProperty(el, 'offsetWidth', { get: () => el.__w, configurable: true })
  return el
}

/** Let the registry's queued-microtask flush run. */
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('OwnGroupWidthRegistry', () => {
  it('pins every group member to the widest natural width', async () => {
    const reg = new OwnGroupWidthRegistry()
    const a = memberWithWidth(374)
    const b = memberWithWidth(400)
    reg.register('g', 'a', a)
    reg.register('g', 'b', b)
    await flush()

    expect(a.style.minWidth).toBe('min(400px, 100%)')
    expect(b.style.minWidth).toBe('min(400px, 100%)')
  })

  it('re-fits the group when a member grows after load (markDirty)', async () => {
    const reg = new OwnGroupWidthRegistry()
    // The image row starts under-measured (image not yet settled) …
    const text = memberWithWidth(374)
    const image = memberWithWidth(374)
    reg.register('g', 'text', text)
    reg.register('g', 'image', image)
    await flush()
    expect(text.style.minWidth).toBe('min(374px, 100%)')

    // … then the image settles to its final width. Without a re-fit the group
    // stays pinned at the stale 374, leaving a ragged edge.
    image.__w = 400
    reg.markDirty('g')
    await flush()

    expect(image.style.minWidth).toBe('min(400px, 100%)')
    expect(text.style.minWidth).toBe('min(400px, 100%)')
  })

  it('re-fits downward when the widest member shrinks', async () => {
    const reg = new OwnGroupWidthRegistry()
    const a = memberWithWidth(374)
    const b = memberWithWidth(400)
    reg.register('g', 'a', a)
    reg.register('g', 'b', b)
    await flush()

    b.__w = 300
    reg.markDirty('g')
    await flush()

    expect(a.style.minWidth).toBe('min(374px, 100%)')
    expect(b.style.minWidth).toBe('min(374px, 100%)')
  })

  it('clears the pinned width when a member unregisters', async () => {
    const reg = new OwnGroupWidthRegistry()
    const a = memberWithWidth(374)
    const b = memberWithWidth(400)
    reg.register('g', 'a', a)
    reg.register('g', 'b', b)
    await flush()

    reg.unregister('g', 'b')
    expect(b.style.minWidth).toBe('')
    expect(b.style.width).toBe('')
  })
})

describe('useOwnGroupWidth', () => {
  // A member component that reports a controllable natural width, mirroring the
  // real hook usage: attach the returned ref to the tint box, and call remeasure
  // to simulate media finishing loading.
  const remeasurers = new Map<string, () => void>()
  const nodes = new Map<string, HTMLElement & { __w: number }>()

  function Member({ id, width }: { id: string; width: number }): ReactNode {
    const { ref, remeasure } = useOwnGroupWidth('g', id, id)
    remeasurers.set(id, remeasure)
    const attach = (node: HTMLDivElement | null) => {
      if (node) {
        const el = node as unknown as HTMLDivElement & { __w: number }
        el.__w = width
        Object.defineProperty(el, 'offsetWidth', { get: () => el.__w, configurable: true })
        nodes.set(id, el)
      }
      ref(node)
    }
    return createElement('div', { ref: attach })
  }

  it('remeasure() re-fits the group after a member grows (media-load path)', async () => {
    remeasurers.clear()
    nodes.clear()
    render(
      createElement(OwnGroupWidthProvider, null,
        createElement(Member, { id: 'text', width: 374 }),
        createElement(Member, { id: 'image', width: 374 }),
      ),
    )
    await act(flush)
    expect(nodes.get('text')!.style.minWidth).toBe('min(374px, 100%)')

    // Image settles to its final width, then the load handler calls remeasure.
    nodes.get('image')!.__w = 400
    await act(async () => {
      remeasurers.get('image')!()
      await flush()
    })

    expect(nodes.get('image')!.style.minWidth).toBe('min(400px, 100%)')
    expect(nodes.get('text')!.style.minWidth).toBe('min(400px, 100%)')
  })
})
