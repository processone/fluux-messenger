import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CollapsibleContent } from './CollapsibleContent'
import { useExpandedMessagesStore } from '@/stores/expandedMessagesStore'

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'chat.showMore': 'Show more',
        'chat.showLess': 'Show less',
      }
      return translations[key] || key
    },
  }),
}))

// Mock ResizeObserver
class MockResizeObserver {
  callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe() {
    // Trigger callback immediately to simulate measurement
    this.callback([], this)
  }
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', MockResizeObserver)

describe('CollapsibleContent', () => {
  beforeEach(() => {
    // Reset store state before each test
    useExpandedMessagesStore.getState().clear()
  })

  it('should render children normally when content is short', () => {
    render(
      <CollapsibleContent messageId="msg-1">
        <p>Short content</p>
      </CollapsibleContent>
    )

    expect(screen.getByText('Short content')).toBeInTheDocument()
    // Show more button should not appear for short content
    expect(screen.queryByText('Show more')).not.toBeInTheDocument()
  })

  it('should show "Show more" button when content exceeds threshold', () => {
    // Mock scrollHeight to simulate tall content
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight'
    )

    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 500 // Exceeds 350px threshold
      },
    })

    render(
      <CollapsibleContent messageId="msg-1">
        <p>Very long content that exceeds the threshold</p>
      </CollapsibleContent>
    )

    expect(screen.getByText('Show more')).toBeInTheDocument()

    // Restore original
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
    }
  })

  it('should toggle between "Show more" and "Show less"', () => {
    // Mock scrollHeight to simulate tall content
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 500
      },
    })

    render(
      <CollapsibleContent messageId="msg-1">
        <p>Long content</p>
      </CollapsibleContent>
    )

    // Initially shows "Show more"
    const button = screen.getByText('Show more')
    expect(button).toBeInTheDocument()

    // Click to expand
    fireEvent.click(button)
    expect(screen.getByText('Show less')).toBeInTheDocument()

    // Click to collapse
    fireEvent.click(screen.getByText('Show less'))
    expect(screen.getByText('Show more')).toBeInTheDocument()
  })

  it('should persist expanded state in store', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 500
      },
    })

    render(
      <CollapsibleContent messageId="msg-1">
        <p>Long content</p>
      </CollapsibleContent>
    )

    // Initially not expanded
    expect(useExpandedMessagesStore.getState().isExpanded('msg-1')).toBe(false)

    // Click to expand
    fireEvent.click(screen.getByText('Show more'))

    // Store should be updated
    expect(useExpandedMessagesStore.getState().isExpanded('msg-1')).toBe(true)
  })

  it('should read initial expanded state from store', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 500
      },
    })

    // Pre-expand in store
    useExpandedMessagesStore.getState().expand('msg-1')

    render(
      <CollapsibleContent messageId="msg-1">
        <p>Long content</p>
      </CollapsibleContent>
    )

    // Should show "Show less" since already expanded
    expect(screen.getByText('Show less')).toBeInTheDocument()
  })

  it('should apply max-height when collapsed', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 500
      },
    })

    const { container } = render(
      <CollapsibleContent messageId="msg-1">
        <p>Long content</p>
      </CollapsibleContent>
    )

    // Find the content container (has overflow-hidden class)
    const contentDiv = container.querySelector('.overflow-hidden')
    expect(contentDiv).toHaveClass('max-h-[350px]')
  })

  it('should remove max-height when expanded', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 500
      },
    })

    const { container } = render(
      <CollapsibleContent messageId="msg-1">
        <p>Long content</p>
      </CollapsibleContent>
    )

    // Expand
    fireEvent.click(screen.getByText('Show more'))

    // max-h class should be removed
    const contentDiv = container.querySelector('.overflow-hidden')
    expect(contentDiv).not.toHaveClass('max-h-[350px]')
  })

  it('should use selection gradient color when isSelected is true', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 500
      },
    })

    const { container } = render(
      <CollapsibleContent messageId="msg-1" isSelected={true}>
        <p>Long content</p>
      </CollapsibleContent>
    )

    // Find the gradient overlay
    const gradientDiv = container.querySelector('.pointer-events-none')
    expect(gradientDiv).toBeTruthy()
    expect(gradientDiv).toHaveStyle({
      background: 'linear-gradient(to bottom, transparent, var(--fluux-selection))',
    })
  })

  it('should use chat gradient color when isSelected is false', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 500
      },
    })

    const { container } = render(
      <CollapsibleContent messageId="msg-1" isSelected={false}>
        <p>Long content</p>
      </CollapsibleContent>
    )

    // Find the gradient overlay
    const gradientDiv = container.querySelector('.pointer-events-none')
    expect(gradientDiv).toBeTruthy()
    expect(gradientDiv).toHaveStyle({
      background: 'linear-gradient(to bottom, transparent, var(--fluux-chat))',
    })
  })
})
