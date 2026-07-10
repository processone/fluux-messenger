// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createRef } from 'react'
import { LinkContextMenu } from './LinkContextMenu'
import type { ContextMenuState } from '@/hooks/useContextMenu'

const copyMock = vi.fn()
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: (t: string) => copyMock(t) }))
const openMock = vi.fn()
vi.mock('@/utils/openInBrowser', () => ({ openInBrowser: (u: string) => openMock(u) }))

function makeMenu(isOpen: boolean): ContextMenuState {
  return {
    isOpen,
    position: { x: 10, y: 20 },
    menuRef: createRef<HTMLDivElement>(),
    longPressTriggered: createRef<boolean>() as ContextMenuState['longPressTriggered'],
    close: vi.fn(),
    handleContextMenu: vi.fn(),
    handleTouchStart: vi.fn(),
    handleTouchEnd: vi.fn(),
  }
}

describe('LinkContextMenu', () => {
  beforeEach(() => {
    copyMock.mockReset()
    openMock.mockReset()
  })

  it('renders nothing when closed', () => {
    const { container } = render(<LinkContextMenu url="https://x.com" menu={makeMenu(false)} />)
    expect(container.firstChild).toBeNull()
  })

  it('copies the link', () => {
    render(<LinkContextMenu url="https://x.com" menu={makeMenu(true)} />)
    fireEvent.click(screen.getByText('Copy link'))
    expect(copyMock).toHaveBeenCalledWith('https://x.com')
  })

  it('opens the link in the browser', () => {
    render(<LinkContextMenu url="https://x.com" menu={makeMenu(true)} />)
    fireEvent.click(screen.getByText('Open in browser'))
    expect(openMock).toHaveBeenCalledWith('https://x.com')
  })
})
