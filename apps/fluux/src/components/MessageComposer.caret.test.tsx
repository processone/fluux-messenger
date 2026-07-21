import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { MessageComposer, type MessageComposerHandle } from './MessageComposer'

/** The composer reports each of its renders to the (mocked) render-loop detector. */
function composerRenderCount(): number {
  return (detectRenderLoop as ReturnType<typeof vi.fn>).mock.calls.filter(
    (call) => call[0] === 'MessageComposer'
  ).length
}

vi.mock('@emoji-mart/data', () => ({
  default: {
    emojis: {
      heart: { name: 'Red Heart', skins: [{ native: '❤️' }], keywords: ['love'] },
    },
  },
}))

vi.mock('./EmojiPicker', () => ({ EmojiPicker: () => <div data-testid="full-emoji-picker" /> }))

function renderComposer(onSelectionChange: (position: number) => void) {
  render(
    <MessageComposer
      placeholder="Type a message"
      onSend={vi.fn().mockResolvedValue(true)}
      onSelectionChange={onSelectionChange}
    />
  )
  return screen.getByPlaceholderText('Type a message') as HTMLTextAreaElement
}

/**
 * Room mention and slash-command completion live in RoomView and are driven by
 * the caret the composer reports. If the composer only reports on selection
 * events, those menus never open while the user types — which is the only time
 * they are useful.
 */
describe('MessageComposer caret reporting', () => {
  it('reports the caret while the user types', () => {
    const onSelectionChange = vi.fn()
    const textarea = renderComposer(onSelectionChange)

    fireEvent.change(textarea, {
      target: { value: 'hi @Em', selectionStart: 6, selectionEnd: 6 },
    })

    expect(onSelectionChange).toHaveBeenCalledWith(6)
  })

  it('reports the caret when a selection event moves it', () => {
    const onSelectionChange = vi.fn()
    const textarea = renderComposer(onSelectionChange)

    fireEvent.change(textarea, {
      target: { value: 'hi @Em', selectionStart: 6, selectionEnd: 6 },
    })
    onSelectionChange.mockClear()

    textarea.setSelectionRange(3, 3)
    fireEvent.select(textarea)

    expect(onSelectionChange).toHaveBeenCalledWith(3)
  })

  /**
   * The caret is stored as an object so it can be paired with its text, but a
   * fresh object on every selection event would re-render where the previous
   * plain number let React bail out. Selection events that do not move the caret
   * must stay free.
   */
  it('does not re-render when a selection event lands on the caret it already had', () => {
    const textarea = renderComposer(vi.fn())
    fireEvent.change(textarea, {
      target: { value: 'stable text', selectionStart: 5, selectionEnd: 5 },
    })

    const beforeStationary = composerRenderCount()
    for (let i = 0; i < 10; i++) {
      textarea.selectionStart = textarea.selectionEnd = 5
      fireEvent.select(textarea)
    }
    expect(composerRenderCount() - beforeStationary).toBe(0)

    // Control: a caret that actually moves must still re-render, or the
    // assertion above would pass simply because nothing is wired up.
    const beforeMoving = composerRenderCount()
    for (let i = 0; i < 10; i++) {
      textarea.selectionStart = textarea.selectionEnd = i
      fireEvent.select(textarea)
    }
    expect(composerRenderCount() - beforeMoving).toBe(10)
  })

  /**
   * A room inserting a mention rewrites the text itself. Without this the
   * browser drops the caret at the end of the value, so `ping @Em| about the
   * release` becomes `ping @Emma  about the release|` and the next keystroke
   * lands at the end of the message instead of after the mention.
   */
  it('places the caret after text the parent rewrote', async () => {
    const onSelectionChange = vi.fn()
    const ref = createRef<MessageComposerHandle>()
    render(
      <MessageComposer
        ref={ref}
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        value="ping @Emma  about the release"
        onValueChange={vi.fn()}
        onSelectionChange={onSelectionChange}
      />
    )
    const textarea = screen.getByPlaceholderText('Type a message') as HTMLTextAreaElement

    act(() => {
      ref.current?.placeCaret('ping @Emma  about the release', 11)
    })

    expect(onSelectionChange).toHaveBeenCalledWith(11)
    await waitFor(() => {
      expect(textarea.selectionStart).toBe(11)
      expect(document.activeElement).toBe(textarea)
    })
  })

  it('reports the caret the completion moved it to', async () => {
    const onSelectionChange = vi.fn()
    const textarea = renderComposer(onSelectionChange)

    fireEvent.change(textarea, {
      target: { value: ':hea', selectionStart: 4, selectionEnd: 4 },
    })
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
    onSelectionChange.mockClear()

    fireEvent.keyDown(textarea, { key: 'Enter' })

    // ':hea' collapsed to '❤️', so the caret sits at the end of the emoji.
    expect(onSelectionChange).toHaveBeenCalledWith('❤️'.length)
  })
})
