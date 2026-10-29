// Intent: FLM-256 / captain's Enter, click, Enter sequence must not resend a
// pending draft. FLM-255 established that a remount resurrected submitted text.
import { useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useConversationDraft, type DraftOperations } from '@/hooks/useConversationDraft'
import { useToastStore } from '@/stores/toastStore'
import { MessageComposer, type MessageComposerHandle } from './MessageComposer'

const BODY = 'Et il y a aussi ce nouveau ticket dolya: https://ejabberd.atlassian.net/browse/EJABS-4575'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const drafts = new Map<string, string>([['emma@fluux.chat', BODY]])
  const operations: DraftOperations = {
    getDraft: id => drafts.get(id) ?? '',
    setDraft: (id, value) => { drafts.set(id, value) },
    clearDraft: id => { drafts.delete(id) },
  }
  function Input({ onSend, id = 'emma@fluux.chat' }: { onSend: (text: string) => Promise<boolean>; id?: string }) {
    const ref = useRef<MessageComposerHandle>(null)
    const [text, setText, consumeDraft] = useConversationDraft({ conversationId: id, draftOperations: operations, composerRef: ref })
    return <MessageComposer ref={ref} placeholder="Message" value={text} onValueChange={setText}
      onConsumeDraft={consumeDraft} onSend={onSend} />
  }
  return { drafts, Input }
}
function field() { return screen.getByPlaceholderText('Message') as HTMLTextAreaElement }
function submit() { fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter' }) }

describe('submitted draft ownership', () => {
  it('consumes the field and saved draft before sending, including an immediate remount', async () => {
    const { Input, drafts } = fixture()
    const send = deferred<boolean>()
    const onSend = vi.fn(() => send.promise)
    const view = render(<Input onSend={onSend} />)
    await act(async () => { submit() })
    expect(field().value).toBe('')
    expect(drafts.has('emma@fluux.chat')).toBe(false)
    view.unmount()
    render(<Input onSend={onSend} />)
    fireEvent.click(field())
    await act(async () => { submit() })
    expect(onSend).toHaveBeenCalledExactlyOnceWith(BODY)
    await act(async () => { send.resolve(true) })
    expect(field().value).toBe('')
  })

  it.each([true, false, 'reject'] as const)('does not erase newer input when a send settles: %s', async result => {
    const { Input, drafts } = fixture()
    const send = deferred<boolean>()
    render(<Input onSend={() => send.promise} />)
    await act(async () => { submit() })
    fireEvent.change(field(), { target: { value: 'Oups' } })
    await act(async () => {
      if (result === 'reject') send.reject(new Error('Socket not available'))
      else send.resolve(result)
    })
    expect(field().value).toBe('Oups')
    expect(drafts.get('emma@fluux.chat')).not.toBe(BODY)
  })

  it('does not resurrect submitted text after the user types and deletes a newer draft', async () => {
    const { Input, drafts } = fixture()
    const send = deferred<boolean>()
    render(<Input onSend={() => send.promise} />)
    await act(async () => { submit() })
    fireEvent.change(field(), { target: { value: 'Oups' } })
    fireEvent.change(field(), { target: { value: '' } })
    await act(async () => { send.resolve(false) })
    expect(field().value).toBe('')
    expect(drafts.has('emma@fluux.chat')).toBe(false)
  })

  it.each([false, 'reject'] as const)('restores an unhandled send without losing whitespace: %s', async result => {
    const { Input, drafts } = fixture()
    const send = deferred<boolean>()
    useToastStore.setState({ toasts: [] })
    render(<Input onSend={() => send.promise} />)
    fireEvent.change(field(), { target: { value: `  ${BODY}  ` } })
    await act(async () => { submit() })
    await act(async () => {
      if (result === 'reject') send.reject(new Error('Socket not available'))
      else send.resolve(false)
    })
    expect(field().value).toBe(`  ${BODY}  `)
    expect(drafts.get('emma@fluux.chat')).toBe(`  ${BODY}  `)
    if (result === 'reject') expect(useToastStore.getState().toasts.at(-1)?.message).toBe('console.failedToSend')
  })

  it('keeps a failed draft for its original recipient after navigating away', async () => {
    const { Input, drafts } = fixture()
    drafts.set('oliver@fluux.chat', 'Good catch.')
    const send = deferred<boolean>()
    const view = render(<Input onSend={() => send.promise} />)
    await act(async () => { submit() })
    view.rerender(<Input id="oliver@fluux.chat" onSend={vi.fn()} />)
    await act(async () => { send.reject(new Error('Socket not available')) })
    expect(field().value).toBe('Good catch.')
    expect(drafts.get('emma@fluux.chat')).toBe(BODY)
  })

  it('recovers the original failed draft after editing another recipient and returning', async () => {
    const { Input, drafts } = fixture()
    const send = deferred<boolean>()
    const view = render(<Input onSend={() => send.promise} />)
    await act(async () => { submit() })
    view.rerender(<Input id="oliver@fluux.chat" onSend={vi.fn()} />)
    fireEvent.change(field(), { target: { value: 'Good catch.' } })
    view.rerender(<Input onSend={() => send.promise} />)
    expect(field().value).toBe('')
    await act(async () => { send.reject(new Error('Socket not available')) })
    expect(field().value).toBe(BODY)
    expect(drafts.get('emma@fluux.chat')).toBe(BODY)
    expect(drafts.get('oliver@fluux.chat')).toBe('Good catch.')
  })

  it('refuses another submission while command resolution is pending', async () => {
    const command = deferred<string | 'consumed'>()
    const resolveInput = vi.fn(() => command.promise)
    const onSend = vi.fn().mockResolvedValue(true)
    render(<MessageComposer placeholder="Message" onSend={onSend} resolveInput={resolveInput} />)
    fireEvent.change(field(), { target: { value: BODY } })
    await act(async () => { submit(); submit() })
    expect(resolveInput).toHaveBeenCalledOnce()
    expect(field().value).toBe('')
    await act(async () => { command.resolve(BODY) })
    expect(onSend).toHaveBeenCalledExactlyOnceWith(BODY)
  })
})
