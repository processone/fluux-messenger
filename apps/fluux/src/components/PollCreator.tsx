/**
 * PollCreator — Modal for creating a new poll in a MUC room.
 */
import { useState, useCallback, useRef, Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { MAX_POLL_OPTIONS, POLL_OPTION_EMOJIS, type PollSettings } from '@fluux/sdk'
import { useClickOutside } from '@/hooks'
import { ModalShell } from './ModalShell'
import { TextInput } from './ui/TextInput'

const EmojiPicker = lazy(() => import('./EmojiPicker').then(m => ({ default: m.EmojiPicker })))

interface PollCreatorProps {
  onClose: () => void
  onCreatePoll: (title: string, options: string[], settings: Partial<PollSettings>, description?: string, deadline?: string, customEmojis?: string[]) => Promise<void>
}

export function PollCreator({ onClose, onCreatePoll }: PollCreatorProps) {
  const { t } = useTranslation()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [emojis, setEmojis] = useState<string[]>([POLL_OPTION_EMOJIS[0], POLL_OPTION_EMOJIS[1]])
  const [allowMultiple, setAllowMultiple] = useState(false)
  const [hideResultsBeforeVote, setHideResultsBeforeVote] = useState(false)
  const [deadline, setDeadline] = useState('')
  const [sending, setSending] = useState(false)
  // Index of the option whose emoji picker is open, or null
  const [emojiPickerIndex, setEmojiPickerIndex] = useState<number | null>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)

  useClickOutside(emojiPickerRef, () => setEmojiPickerIndex(null), emojiPickerIndex !== null)

  const canAddOption = options.length < MAX_POLL_OPTIONS
  const canRemoveOption = options.length > 2
  const isValid = title.trim().length > 0 && options.filter((o) => o.trim().length > 0).length >= 2

  const addOption = useCallback(() => {
    if (canAddOption) {
      setOptions((prev) => [...prev, ''])
      setEmojis((prev) => [...prev, POLL_OPTION_EMOJIS[prev.length] ?? '🔘'])
    }
  }, [canAddOption])

  const removeOption = useCallback((index: number) => {
    if (canRemoveOption) {
      setOptions((prev) => prev.filter((_, i) => i !== index))
      setEmojis((prev) => prev.filter((_, i) => i !== index))
      // Close picker if the removed option had it open
      setEmojiPickerIndex((prev) => {
        if (prev === index) return null
        if (prev !== null && prev > index) return prev - 1
        return prev
      })
    }
  }, [canRemoveOption])

  const updateOption = useCallback((index: number, value: string) => {
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)))
  }, [])

  const handleEmojiSelect = useCallback((index: number, emoji: string) => {
    setEmojis((prev) => prev.map((e, i) => (i === index ? emoji : e)))
    setEmojiPickerIndex(null)
  }, [])

  const handleSubmit = async () => {
    if (!isValid || sending) return
    const trimmedOptions = options.map((o) => o.trim()).filter((o) => o.length > 0)
    if (trimmedOptions.length < 2) return

    setSending(true)
    try {
      const trimmedDesc = description.trim() || undefined
      const deadlineIso = deadline ? new Date(deadline).toISOString() : undefined
      // Only pass customEmojis if any differ from the default numbered set
      const trimmedEmojis = emojis.slice(0, trimmedOptions.length)
      const hasCustomEmojis = trimmedEmojis.some((e, i) => e !== POLL_OPTION_EMOJIS[i])
      const customEmojis = hasCustomEmojis ? trimmedEmojis : undefined
      await onCreatePoll(title.trim(), trimmedOptions, { allowMultiple, hideResultsBeforeVote }, trimmedDesc, deadlineIso, customEmojis)
      onClose()
    } catch {
      setSending(false)
    }
  }

  return (
    <ModalShell title={t('poll.create', 'Create Poll')} onClose={onClose} width="max-w-sm">
      <div className="p-4 flex flex-col gap-4">
        {/* Title */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-fluux-text">
            {t('poll.title', 'Title')}
          </label>
          <TextInput
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('poll.titlePlaceholder', 'Ask a question...')}
            className="px-3 py-2 rounded-md border border-fluux-border bg-fluux-bg text-fluux-text text-sm placeholder:text-fluux-muted focus:outline-none focus:border-fluux-brand"
            autoFocus
            maxLength={200}
          />
        </div>

        {/* Description (optional) */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-fluux-text">
            {t('poll.description', 'Description')}
            <span className="text-fluux-muted font-normal ms-1">
              {t('common.optional', '(optional)')}
            </span>
          </label>
          <TextInput
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('poll.descriptionPlaceholder', 'Add context or details...')}
            className="px-3 py-2 rounded-md border border-fluux-border bg-fluux-bg text-fluux-text text-sm placeholder:text-fluux-muted focus:outline-none focus:border-fluux-brand"
            maxLength={300}
          />
        </div>

        {/* Options */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-fluux-text">
            {t('poll.options', 'Options')}
          </label>
          {options.map((option, index) => (
            <div key={index} className="flex items-center gap-2">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setEmojiPickerIndex(emojiPickerIndex === index ? null : index)}
                  className={`text-base flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-md border transition-colors
                    ${emojiPickerIndex === index
                      ? 'border-fluux-brand bg-fluux-brand/10'
                      : 'border-transparent hover:border-fluux-border hover:bg-fluux-hover'
                    }`}
                  title={t('poll.changeEmoji', 'Click to change emoji')}
                >
                  {emojis[index] ?? POLL_OPTION_EMOJIS[index]}
                </button>
                {emojiPickerIndex === index && (
                  <div ref={emojiPickerRef} className="absolute start-0 top-full mt-1 z-50">
                    <Suspense fallback={null}>
                      <EmojiPicker
                        onSelect={(emoji) => handleEmojiSelect(index, emoji)}
                        onClose={() => setEmojiPickerIndex(null)}
                      />
                    </Suspense>
                  </div>
                )}
              </div>
              <TextInput
                type="text"
                value={option}
                onChange={(e) => updateOption(index, e.target.value)}
                placeholder={t('poll.optionPlaceholder', 'Option {{number}}', { number: index + 1 })}
                className="flex-1 px-3 py-2 rounded-md border border-fluux-border bg-fluux-bg text-fluux-text text-sm placeholder:text-fluux-muted focus:outline-none focus:border-fluux-brand"
                maxLength={100}
              />
              {canRemoveOption && (
                <button
                  onClick={() => removeOption(index)}
                  className="p-1 text-fluux-muted hover:text-red-500 transition-colors"
                  aria-label={t('poll.removeOption', 'Remove option')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}

          {canAddOption && (
            <button
              onClick={addOption}
              className="flex items-center gap-1.5 text-sm text-fluux-brand hover:text-fluux-text transition-colors mt-1"
            >
              <Plus className="w-4 h-4" />
              {t('poll.addOption', 'Add option')}
            </button>
          )}
        </div>

        {/* Settings */}
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={allowMultiple}
              onChange={(e) => setAllowMultiple(e.target.checked)}
              className="rounded border-fluux-border"
            />
            <span className="text-sm text-fluux-text">
              {t('poll.allowMultiple', 'Allow multiple votes')}
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={hideResultsBeforeVote}
              onChange={(e) => setHideResultsBeforeVote(e.target.checked)}
              className="rounded border-fluux-border"
            />
            <span className="text-sm text-fluux-text">
              {t('poll.hideResultsBeforeVote', 'Hide results until voted')}
            </span>
          </label>
        </div>

        {/* Deadline (optional) */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-fluux-text">
            {t('poll.deadline', 'Deadline')}
            <span className="text-fluux-muted font-normal ms-1">
              {t('common.optional', '(optional)')}
            </span>
          </label>
          <input
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            min={new Date().toISOString().slice(0, 16)}
            className="px-3 py-2 rounded-md border border-fluux-border bg-fluux-bg text-fluux-text text-sm focus:outline-none focus:border-fluux-brand"
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-fluux-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-fluux-muted hover:text-fluux-text transition-colors"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isValid || sending}
            className="px-4 py-2 text-sm font-medium text-fluux-text-on-accent bg-fluux-brand rounded-md hover:bg-fluux-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {sending && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('poll.send', 'Send Poll')}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
