import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MenuButton,
  SidebarListMenuPortal,
  SidebarListMenuProvider,
  useSidebarListMenu,
} from './SidebarListMenu'

// Keep the real positioning and outside-click hooks without loading unrelated hooks.
vi.mock('@/hooks', async () => ({
  ...await import('@/hooks/useClickOutside'),
  ...await import('@/hooks/useMenuViewportClamp'),
}))

const conversation = { id: 'olivia', name: 'Olivia Park' }

function List() {
  const { getItemMenuProps, targetItem, menuRef, close } = useSidebarListMenu<typeof conversation>()
  return (
    <>
      <button {...getItemMenuProps(conversation)}>{conversation.name}</button>
      <SidebarListMenuPortal>
        <MenuButton icon={null} label="Archiver" onClick={close} />
        <MenuButton icon={null} label="Supprimer" onClick={close} />
        <output>{targetItem?.id}</output>
        <button onClick={() => menuRef.current?.focus()}>Focus menu</button>
      </SidebarListMenuPortal>
    </>
  )
}

function renderList() {
  return render(
    <div data-testid="scrolling-list" style={{ overflowY: 'auto', height: 518, marginTop: 78 }}>
      <SidebarListMenuProvider><List /></SidebarListMenuProvider>
    </div>,
  )
}

afterEach(() => vi.useRealTimers())

describe('sidebar menu — issue #1790', () => {
  it('escapes the scrolling list while preserving the anchor, target, ref and action', () => {
    const { unmount } = renderList()
    expect(screen.queryByRole('button', { name: 'Archiver' })).not.toBeInTheDocument()
    fireEvent.contextMenu(screen.getByText(conversation.name), { clientX: 215, clientY: 552 })
    const archive = screen.getByRole('button', { name: 'Archiver' })
    const menu = archive.parentElement!
    // Issue #1790's native reproduction: a fixed menu in this scroll tree is clipped in iOS WebKit,
    // even though its bounds fit the viewport and DOM hit-testing reports success.
    // This checks the containment correction; native screenshot checks own paint.
    expect(menu.parentElement).toBe(document.body)
    expect(screen.getByTestId('scrolling-list')).not.toContainElement(menu)
    expect(menu).toHaveStyle({ left: '215px', top: '552px' })
    expect(menu).toHaveTextContent(conversation.id)
    // The provider's ref must still point at the portaled element.
    const focus = vi.spyOn(menu, 'focus')
    fireEvent.click(screen.getByRole('button', { name: 'Focus menu' }))
    expect(focus).toHaveBeenCalledOnce()
    fireEvent.mouseDown(archive)
    expect(archive).toBeInTheDocument()
    fireEvent.click(archive)
    expect(menu).not.toBeInTheDocument()
    fireEvent.contextMenu(screen.getByText(conversation.name), { clientX: 215, clientY: 552 })
    unmount()
    expect(screen.queryByRole('button', { name: 'Supprimer' })).not.toBeInTheDocument()
  })

  it('keeps long-press opening and outside dismissal across the portal boundary', () => {
    vi.useFakeTimers()
    renderList()
    fireEvent.touchStart(screen.getByText(conversation.name), {
      touches: [{ clientX: 215, clientY: 552 }],
    })
    act(() => vi.advanceTimersByTime(500))
    fireEvent.touchEnd(screen.getByText(conversation.name))
    expect(screen.getByRole('button', { name: 'Supprimer' })).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('button', { name: 'Supprimer' })).not.toBeInTheDocument()
  })

  it('still dismisses when its original list scrolls', () => {
    renderList()
    fireEvent.contextMenu(screen.getByText(conversation.name), { clientX: 215, clientY: 552 })
    expect(screen.getByRole('button', { name: 'Archiver' })).toBeInTheDocument()
    fireEvent.scroll(screen.getByTestId('scrolling-list'))
    expect(screen.queryByRole('button', { name: 'Archiver' })).not.toBeInTheDocument()
  })
})
