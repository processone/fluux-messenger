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
  const scrim = root.querySelector('.modal-scrim')
  const panel = root.querySelector('.fluux-glass')
  expect(scrim, 'no .modal-scrim element rendered').not.toBeNull()
  expect(panel, 'no .fluux-glass panel rendered').not.toBeNull()
  expect(
    scrim!.contains(panel!),
    'the .fluux-glass panel is nested inside .modal-scrim, so its backdrop-filter will be discarded',
  ).toBe(false)
}

describe('glass panel escapes the scrim backdrop root', () => {
  it('ModalOverlay renders the panel as a sibling of the scrim', () => {
    const { container } = render(
      <ModalOverlay onClose={vi.fn()}>
        <button>ok</button>
      </ModalOverlay>,
    )
    expectPanelOutsideScrim(container)
  })

  it('BottomSheet renders the panel as a sibling of the scrim', () => {
    render(
      <BottomSheet open onClose={vi.fn()} ariaLabel="actions">
        <button>ok</button>
      </BottomSheet>,
    )
    // BottomSheet portals to document.body, so query from there.
    expectPanelOutsideScrim(document.body)
  })
})
