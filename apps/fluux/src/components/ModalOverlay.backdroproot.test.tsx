// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ModalOverlay } from './ModalOverlay'
import { BottomSheet } from './ui/BottomSheet'

afterEach(cleanup)

/**
 * An element with `backdrop-filter` forms a Backdrop Root: a descendant's own
 * backdrop-filter then samples only content inside that root, so the
 * descendant's frost is silently discarded. `.modal-scrim` carries a
 * backdrop-filter, so the `.fluux-glass` panel must never be nested inside it.
 *
 * This failure mode is invisible — nothing throws, no style is dropped, the
 * frost simply stops painting — which is exactly why it survived unnoticed and
 * why it needs a structural guard rather than a visual review.
 */
function expectPanelOutsideScrim(root: ParentNode) {
  const wrapper = root.querySelector('[data-modal="true"]')
  const scrim = root.querySelector('.modal-scrim')
  const panel = root.querySelector('.fluux-glass')
  expect(wrapper, 'no [data-modal="true"] wrapper rendered').not.toBeNull()
  expect(scrim, 'no .modal-scrim element rendered').not.toBeNull()
  expect(panel, 'no .fluux-glass panel rendered').not.toBeNull()
  expect(
    scrim!.contains(panel!),
    'the .fluux-glass panel is nested inside .modal-scrim, so its backdrop-filter will be discarded',
  ).toBe(false)
  // Not just "outside the scrim" but DIRECTLY under the layout wrapper: an
  // extra wrapper inserted between them (e.g. a scroll container with
  // opacity-90, filter, or isolate) forms its own backdrop/stacking root and
  // would silently discard the panel's frost just as effectively as nesting it
  // in the scrim would.
  expect(
    panel!.parentElement,
    'the .fluux-glass panel must be a DIRECT child of the [data-modal="true"] wrapper — an intervening wrapper element can form its own backdrop root (opacity, filter, isolate, …) and discard the panel frost just like the scrim would',
  ).toBe(wrapper)
}

describe('glass panel escapes the scrim backdrop root', () => {
  it('ModalOverlay renders the panel as a sibling of the scrim', () => {
    const { container } = render(
      <ModalOverlay onClose={vi.fn()}>
        <button type="button">ok</button>
      </ModalOverlay>,
    )
    expectPanelOutsideScrim(container)
  })

  it('BottomSheet renders the panel as a sibling of the scrim', () => {
    render(
      <BottomSheet open onClose={vi.fn()} ariaLabel="actions">
        <button type="button">ok</button>
      </BottomSheet>,
    )
    // BottomSheet portals to document.body, so query from there.
    expectPanelOutsideScrim(document.body)
  })
})
