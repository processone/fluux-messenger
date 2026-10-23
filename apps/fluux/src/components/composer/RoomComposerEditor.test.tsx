/**
 * Intents (review R2, R3):
 * - a paste the composer claims (an image with an accompanying URL) must be
 *   decided before the editor inserts the clipboard text;
 * - replacing mentions with identical plain text keeps the string but removes the
 *   mention nodes, and the parent's references must follow.
 */
import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MentionReference } from '@fluux/sdk'
import { RoomComposerEditor, type RoomComposerEditorProps } from './RoomComposerEditor'
import type { ComposerInputElement } from './composerInput'

const mention: MentionReference = { begin: 3, end: 7, type: 'mention', uri: 'xmpp:team@conference.example/Bob' }

function setup(value: string, references: MentionReference[], onPaste: RoomComposerEditorProps['onPaste'] = vi.fn()) {
  let input: ComposerInputElement | null = null
  const onEdit = vi.fn()
  const onChange = vi.fn()
  render(
    <RoomComposerEditor
      value={value}
      references={references}
      placeholder="Message"
      ariaProps={{}}
      mergedRef={(node) => { input = node ?? input }}
      onEdit={onEdit}
      onChange={onChange}
      onSelect={vi.fn()}
      onKeyDown={vi.fn()}
      onPaste={onPaste}
    />,
  )
  return { input: input as unknown as ComposerInputElement, onEdit, onChange }
}

// jsdom has no ClipboardEvent; the editor recognises a paste by its class.
if (typeof globalThis.ClipboardEvent === 'undefined') {
  class ClipboardEventShim extends Event {}
  Object.defineProperty(ClipboardEventShim, 'name', { value: 'ClipboardEvent' })
  Object.defineProperty(globalThis, 'ClipboardEvent', { value: ClipboardEventShim, configurable: true })
}

async function paste(target: HTMLElement, data: { text?: string; image?: boolean }) {
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
  const file = new File(['x'], 'shot.png', { type: 'image/png' })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      types: [...(data.text ? ['text/plain'] : []), ...(data.image ? ['Files'] : [])],
      files: data.image ? [file] : [],
      items: data.image ? [{ kind: 'file', type: 'image/png', getAsFile: () => file }] : [],
      getData: (type: string) => (type === 'text/plain' ? data.text ?? '' : ''),
    },
  })
  await act(async () => { target.dispatchEvent(event); await Promise.resolve() })
  return event
}

describe('RoomComposerEditor paste', () => {
  it('lets the composer claim a paste before text is inserted', async () => {
    const onPaste = vi.fn((e: { preventDefault(): void }) => e.preventDefault())
    const { input, onEdit } = setup('', [], onPaste as RoomComposerEditorProps['onPaste'])
    act(() => input.setSelectionRange(0, 0))

    await paste(input, { text: 'https://example.com/shot.png', image: true })

    expect(onPaste).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('')
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('still inserts a plain-text paste the composer does not claim', async () => {
    const { input } = setup('', [])
    act(() => input.setSelectionRange(0, 0))
    await paste(input, { text: 'hello' })
    expect(input.value).toBe('hello')
  })

  it('publishes mentions lost to a paste that leaves the text unchanged', async () => {
    const { input, onEdit, onChange } = setup('hi @Bob', [mention])
    act(() => input.setSelectionRange(0, 7))

    await paste(input, { text: 'hi @Bob' })

    expect(input.value).toBe('hi @Bob')
    expect(onEdit).toHaveBeenLastCalledWith('hi @Bob', [])
    expect(onChange).not.toHaveBeenCalled()
  })
})

/**
 * Intent (review R1): the textarea this editor replaced stripped C0 control
 * characters Tauri's macOS webview inserts; the room draft, and the XML sent from
 * it, must not carry them either.
 */
describe('RoomComposerEditor control characters', () => {
  it('keeps a sanitized paste as one undo step that redo restores', async () => {
    const { input } = setup('', [])
    act(() => input.setSelectionRange(0, 0))
    await paste(input, { text: 'a\u0001b\u007fc' })
    expect(input.value).toBe('abc')

    const shortcut = (shiftKey: boolean) => act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey, bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await shortcut(false)
    expect(input.value).toBe('')
    await shortcut(true)
    expect(input.value).toBe('abc')
  })

  it('strips control characters from pasted text and keeps the caret after the text', async () => {
    const { input, onEdit } = setup('', [])
    act(() => input.setSelectionRange(0, 0))

    await paste(input, { text: 'a\u0001b\u007fc\nd\te' })

    expect(input.value).toBe('abc\nd\te')
    expect(onEdit).toHaveBeenLastCalledWith('abc\nd\te', [])
    expect(input.selectionStart).toBe('abc\nd\te'.length)
  })
})

/**
 * Intent (review R2): restoring a saved draft is passive, as it was in the
 * textarea. It must not take focus or create a caret; explicit actions (mention,
 * emoji, edit) focus through the composer, which this does not touch.
 */
describe('RoomComposerEditor draft restore', () => {
  it('does not take focus or create a caret when a restored draft replaces the value', () => {
    let input: ComposerInputElement | null = null
    const props = {
      references: [] as MentionReference[],
      placeholder: 'Message',
      ariaProps: {},
      mergedRef: (node: ComposerInputElement | null) => { input = node ?? input },
      onEdit: vi.fn(), onChange: vi.fn(), onSelect: vi.fn(), onKeyDown: vi.fn(),
    }
    getSelection()?.removeAllRanges()
    const { rerender } = render(<RoomComposerEditor {...props} value="" />)
    rerender(<RoomComposerEditor {...props} value="a saved draft" />)

    expect((input as unknown as ComposerInputElement).value).toBe('a saved draft')
    expect(document.activeElement).not.toBe(input)
    expect(getSelection()?.rangeCount ? getSelection()!.anchorNode : null).toBeNull()
  })
})
