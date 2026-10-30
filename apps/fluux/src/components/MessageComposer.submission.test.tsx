// Intent: FLM-256 / captain's Enter, click, Enter sequence must not resend a
// pending draft. FLM-255 established that a remount resurrected submitted text.
import { useMemo, useRef, type ComponentProps } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useConversationDraft, type DraftOperations } from '@/hooks/useConversationDraft'
import { useToastStore } from '@/stores/toastStore'
import { MessageComposer, type MessageComposerHandle } from './MessageComposer'

// W1/W2/I2: captain selected draft recovery, live restoration and action wording.
const account = vi.hoisted(() => ({ jid: 'mickael@fluux.chat' }))
vi.mock('@fluux/sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@fluux/sdk')>(),
  getStorageScopeJid: () => account.jid,
}))
afterEach(() => { account.jid = 'mickael@fluux.chat' })

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
    owner: {},
    getDraft: id => drafts.get(id) ?? '',
    setDraft: (id, value) => { drafts.set(id, value) },
    clearDraft: id => { drafts.delete(id) },
  }
  function Input({ onSend, id = 'emma@fluux.chat', editingMessage, onCancelEdit, onSendCorrection }: {
    onSend: (text: string) => Promise<boolean>; id?: string
    editingMessage?: ComponentProps<typeof MessageComposer>['editingMessage'] & { conversationId?: string }
    onCancelEdit?: () => void
    onSendCorrection?: ComponentProps<typeof MessageComposer>['onSendCorrection']
  }) {
    const ref = useRef<MessageComposerHandle>(null)
    // Real useChatActions wraps these actions anew on each mount.
    const wrapped = useMemo(() => ({
      owner: operations.owner,
      getDraft: (id: string) => operations.getDraft(id),
      setDraft: (id: string, value: string) => operations.setDraft(id, value),
      clearDraft: (id: string) => operations.clearDraft(id),
    }), [operations])
    const [text, setText, consumeDraft] = useConversationDraft({ conversationId: id, draftOperations: wrapped, composerRef: ref, isEditing: !!editingMessage,
      editingConversationId: editingMessage ? (editingMessage.conversationId ?? id) : undefined })
    return <MessageComposer ref={ref} placeholder="Message" value={text} onValueChange={setText}
      onConsumeDraft={consumeDraft} onSend={onSend} editingMessage={editingMessage}
      onCancelEdit={onCancelEdit} onSendCorrection={onSendCorrection} />
  }
  return { drafts, Input }
}
function field() { return screen.getByPlaceholderText('Message') as HTMLTextAreaElement }
function submit() { fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter' }) }

describe('submitted draft ownership', () => {
  // N1: captain chose holding failed text until a different message's edit ends.
  it.each(['cancel', 'save'] as const)('holds a failed send outside another message edit until %s', async finish => {
    const { Input, drafts } = fixture()
    const send = deferred<boolean>()
    const onSend = vi.fn(() => send.promise)
    const onSendCorrection = vi.fn().mockResolvedValue(true)
    const onCancelEdit = vi.fn()
    const view = render(<Input onSend={onSend} />)
    await act(async () => { submit() })
    view.rerender(<Input onSend={onSend} editingMessage={{ id: 'earlier-message', body: 'Good catch.' }}
      onCancelEdit={onCancelEdit} onSendCorrection={onSendCorrection} />)
    await act(async () => { send.reject(new Error('Socket not available')) })
    expect(field().value).toBe('Good catch.')
    expect(drafts.get('emma@fluux.chat')).toBe(BODY)
    if (finish === 'cancel') fireEvent.keyDown(field(), { key: 'Escape' })
    else await act(async () => { submit() })
    expect(onCancelEdit).toHaveBeenCalledOnce()
    view.rerender(<Input onSend={onSend} />)
    expect(field().value).toBe(BODY)
    expect(drafts.get('emma@fluux.chat')).toBe(BODY)
    if (finish === 'save') expect(onSendCorrection).toHaveBeenCalledExactlyOnceWith('earlier-message', 'Good catch.', undefined)
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('keeps held failed text through an edit remount before the edit ends', async () => {
    const { Input, drafts } = fixture()
    const send = deferred<boolean>()
    const onSend = () => send.promise
    const editingMessage = { id: 'earlier-message', body: 'Good catch.' }
    const first = render(<Input onSend={onSend} />)
    await act(async () => { submit() })
    first.rerender(<Input onSend={onSend} editingMessage={editingMessage} />)
    await act(async () => { send.reject(new Error('Socket not available')) })
    expect(field().value).toBe('Good catch.')
    first.unmount()
    const second = render(<Input onSend={onSend} editingMessage={editingMessage} />)
    expect(field().value).toBe('Good catch.')
    second.rerender(<Input onSend={onSend} />)
    expect(field().value).toBe(BODY)
    expect(drafts.get('emma@fluux.chat')).toBe(BODY)
  })

  it('keeps a held failure with its recipient when leaving an edit for another conversation', async () => {
    const { Input, drafts } = fixture()
    drafts.set('oliver@fluux.chat', 'Another ordinary draft')
    const send = deferred<boolean>()
    const onSend = () => send.promise
    const view = render(<Input onSend={onSend} />)
    await act(async () => { submit() })
    const editingMessage = { id: 'earlier-message', body: 'Good catch.', conversationId: 'emma@fluux.chat' }
    view.rerender(<Input onSend={onSend} editingMessage={editingMessage} />)
    await act(async () => { send.reject(new Error('Socket not available')) })
    // E1: the real parent drops the old edit only in its next effect/render.
    view.rerender(<Input onSend={onSend} id="oliver@fluux.chat" editingMessage={editingMessage} />)
    expect(field().value).toBe('Another ordinary draft')
    view.rerender(<Input onSend={onSend} id="oliver@fluux.chat" />)
    expect(field().value).toBe('Another ordinary draft')
    expect(drafts.get('oliver@fluux.chat')).toBe('Another ordinary draft')
    expect(drafts.get('emma@fluux.chat')).toBe(BODY)
    view.rerender(<Input onSend={onSend} />)
    expect(field().value).toBe(BODY)
  })

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
    expect(field().value).toContain('Oups')
    if (result === true) {
      expect(field().value).toBe('Oups')
      expect(drafts.get('emma@fluux.chat')).not.toBe(BODY)
    } else {
      expect(field().value).toContain(BODY)
      expect(drafts.get('emma@fluux.chat')).toBe(field().value)
    }
  })

  it('keeps failed text as a draft after the user types and deletes newer input', async () => {
    const { Input, drafts } = fixture()
    const send = deferred<boolean>()
    render(<Input onSend={() => send.promise} />)
    await act(async () => { submit() })
    fireEvent.change(field(), { target: { value: 'Oups' } })
    fireEvent.change(field(), { target: { value: '' } })
    await act(async () => { send.resolve(false) })
    expect(field().value).toBe(BODY)
    expect(drafts.get('emma@fluux.chat')).toBe(BODY)
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
    if (result === 'reject') expect(useToastStore.getState().toasts.at(-1)?.message).toBe('chat.failedToSendMessage')
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

  it.each(['', 'Oups'])('restores a failed send into the remounted live box with newer input %s', async newer => {
    const { Input, drafts } = fixture()
    const send = deferred<boolean>()
    const first = render(<Input onSend={() => send.promise} />)
    await act(async () => { submit() })
    first.unmount()
    const second = render(<Input onSend={vi.fn()} />)
    if (newer) fireEvent.change(field(), { target: { value: newer } })
    await act(async () => { send.reject(new Error('Socket not available')) })
    expect(field().value).toContain(BODY)
    if (newer) expect(field().value).toContain(newer)
    expect(drafts.get('emma@fluux.chat')).toBe(field().value)
    const recovered = field().value
    fireEvent.change(field(), { target: { value: `${recovered}!` } })
    second.unmount()
    render(<Input onSend={vi.fn()} />)
    expect(field().value).toBe(`${recovered}!`)
  })

  it('keeps both failed submissions and current input when remounted sends fail out of order', async () => {
    const { Input, drafts } = fixture()
    const firstSend = deferred<boolean>()
    const secondSend = deferred<boolean>()
    const onSend = vi.fn().mockReturnValueOnce(firstSend.promise).mockReturnValueOnce(secondSend.promise)
    const first = render(<Input onSend={onSend} />)
    await act(async () => { submit() })
    first.unmount()
    render(<Input onSend={onSend} />)
    fireEvent.change(field(), { target: { value: 'Oups' } })
    await act(async () => { submit() })
    fireEvent.change(field(), { target: { value: 'Good catch.' } })
    await act(async () => { firstSend.reject(new Error('Socket not available')) })
    await act(async () => { secondSend.reject(new Error('Socket not available')) })
    expect(field().value).toContain(BODY)
    expect(field().value).toContain('Oups')
    expect(field().value).toContain('Good catch.')
    expect(drafts.get('emma@fluux.chat')).toBe(field().value)
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('keeps failed text beside newer input without a persisted-draft hook', async () => {
    const send = deferred<boolean>()
    render(<MessageComposer placeholder="Message" onSend={() => send.promise} />)
    fireEvent.change(field(), { target: { value: BODY } })
    await act(async () => { submit() })
    fireEvent.change(field(), { target: { value: 'Oups' } })
    await act(async () => { send.reject(new Error('Socket not available')) })
    expect(field().value).toContain('Oups')
    expect(field().value).toContain(BODY)
  })

  it('does not recover a previous account draft into the current account', async () => {
    const { Input, drafts } = fixture()
    const send = deferred<boolean>()
    render(<Input onSend={() => send.promise} />)
    await act(async () => { submit() })
    account.jid = 'oliver@fluux.chat'
    fireEvent.change(field(), { target: { value: 'Good catch.' } })
    await act(async () => { send.reject(new Error('Socket not available')) })
    expect(field().value).toBe('Good catch.')
    expect(drafts.get('emma@fluux.chat')).not.toBe(BODY)
  })

  it.each([
    { action: 'send', key: 'chat.failedToSendMessage' },
    { action: 'correction', key: 'chat.failedToEditMessage' },
    { action: 'retraction', key: 'chat.failedToDeleteMessage' },
  ])('uses chat-specific failure wording for $action', async ({ action, key }) => {
    useToastStore.setState({ toasts: [] })
    const reject = vi.fn().mockRejectedValue(new Error('Socket not available'))
    render(<MessageComposer placeholder="Message" onSend={reject}
      editingMessage={action === 'send' ? null : { id: 'original', body: BODY }}
      onSendCorrection={reject} onRetractMessage={reject} />)
    if (action === 'send') fireEvent.change(field(), { target: { value: BODY } })
    if (action === 'retraction') fireEvent.change(field(), { target: { value: '' } })
    await act(async () => { submit() })
    expect(reject).toHaveBeenCalledOnce()
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ type: 'error', message: key })
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
