import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useFocusZones } from '@/hooks/useFocusZones'
import { useListKeyboardNav } from '@/hooks/useListKeyboardNav'
import { ImageLightbox } from './ImageLightbox'
import { AvatarLightbox } from './AvatarLightbox'
import { ModalOverlay } from './ModalOverlay'
import { BottomSheet } from './ui/BottomSheet'
import { TouchMenu } from './ui/TouchMenu'

vi.mock('./Avatar', () => ({ Avatar: () => null }))
vi.mock('@/hooks', () => ({ useAttachmentUrl: () => ({ url: null, isLoading: false }) }))
vi.mock('@/hooks/useCachedMediaUrl', () => ({ useCachedMediaUrl: () => ({ cachedUrl: null }) }))
vi.mock('./ImageContextMenu', () => ({ ImageContextMenu: () => null }))

const items = ['one', 'two']
const onSelect = vi.fn()

function Background() {
  const sidebarList = useRef<HTMLDivElement>(null)
  const mainContent = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLDivElement>(null)
  useFocusZones({ sidebarList, mainContent, composer })
  const { selectedIndex } = useListKeyboardNav({
    items, onSelect, listRef: sidebarList, getItemId: (item) => item,
  })
  return <>
    <div ref={sidebarList} tabIndex={0}>Sidebar</div>
    <div ref={mainContent} tabIndex={0}>Conversation</div>
    <div ref={composer} tabIndex={0}>Composer</div>
    <output aria-label="Selected background item">{selectedIndex}</output>
  </>
}

const lightboxes = [
  { name: 'ImageLightbox', render: (onClose: () => void) => <ImageLightbox src="https://example.com/image.png" downloadUrl="https://example.com/image.png" onClose={onClose} /> },
  { name: 'AvatarLightbox', render: (onClose: () => void) => <AvatarLightbox identifier="user@example.com" onClose={onClose} /> },
]
const overlays = [
  ...lightboxes,
  { name: 'BottomSheet', render: (onClose: () => void) => <BottomSheet open onClose={onClose}><button type="button">Sheet action</button></BottomSheet> },
  { name: 'TouchMenu', render: (onClose: () => void) => <TouchMenu open onClose={onClose} ariaLabel="Actions"><button type="button">Menu action</button></TouchMenu> },
]

beforeEach(() => {
  document.documentElement.dataset.motion = 'reduced'
  onSelect.mockClear()
})
afterEach(() => delete document.documentElement.dataset.motion)

describe.each(lightboxes)('$name keyboard isolation', ({ render: lightbox }) => {
  it('keeps Tab, Shift+Tab and arrow navigation inside the lightbox', () => {
    render(<Background />)
    screen.getByText('Composer').focus()
    const view = render(lightbox(vi.fn()))
    const buttons = screen.getAllByRole('button')
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    expect(first).toHaveFocus()

    first.focus()
    fireEvent.keyDown(first, { key: 'Tab' })
    expect(buttons).toContain(document.activeElement)
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()

    fireEvent.keyDown(last, { key: 'ArrowDown' })
    fireEvent.keyDown(last, { key: 'ArrowUp' })
    fireEvent.keyDown(last, { key: 'Enter' })
    expect(last).toHaveFocus()
    expect(screen.getByLabelText('Selected background item')).toHaveTextContent('-1')
    expect(onSelect).not.toHaveBeenCalled()

    view.unmount()
    expect(screen.getByText('Composer')).toHaveFocus()
    fireEvent.keyDown(screen.getByText('Composer'), { key: 'Tab' })
    expect(screen.getByText('Sidebar')).toHaveFocus()
  })
})

describe.each(overlays)('$name Escape stacking', ({ render: overlay }) => {
  it('dismisses only the overlay above a dialog, then restores the dialog', () => {
    const closeDialog = vi.fn()
    const closeOverlay = vi.fn()
    render(<ModalOverlay onClose={closeDialog}><button type="button">Dialog action</button></ModalOverlay>)
    const top = render(overlay(closeOverlay))

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(closeOverlay).toHaveBeenCalledTimes(1)
    expect(closeDialog).not.toHaveBeenCalled()

    top.unmount()
    expect(screen.getByText('Dialog action')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(closeDialog).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('leaves the overlay open under a dialog with dismissable=%s', (dismissable) => {
    const closeOverlay = vi.fn()
    const closeDialog = vi.fn()
    render(overlay(closeOverlay))
    const top = render(<ModalOverlay onClose={closeDialog} dismissable={dismissable}><button type="button">Dialog action</button></ModalOverlay>)

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(closeDialog).toHaveBeenCalledTimes(dismissable ? 1 : 0)
    expect(closeOverlay).not.toHaveBeenCalled()

    top.unmount()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(closeOverlay).toHaveBeenCalledTimes(1)
  })
})
