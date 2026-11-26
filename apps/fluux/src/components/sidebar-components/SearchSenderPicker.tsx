import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { parseRoomSender } from '@fluux/sdk'
import { useCloseOnEscape } from '@/hooks/useCloseOnEscape'
import { TextInput } from '../ui/TextInput'
import type { SenderOption } from './searchOperators'

interface Props {
  value: string
  summary?: string
  senders: readonly SenderOption[]
  onChange: (value: string) => void
}

const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ')
const countLabels = (options: readonly SenderOption[]) => {
  const counts = new Map<string, number>()
  for (const { label } of options) counts.set(label, (counts.get(label) ?? 0) + 1)
  return counts
}
const fieldClass = 'w-full min-w-0 px-3 py-2 bg-fluux-bg text-fluux-text border border-fluux-border rounded text-sm'

export function SearchSenderPicker({ value, summary, senders, onChange }: Props) {
  const { t } = useTranslation()
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const restoreFocus = useRef(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const shortcuts = [{ value: '', label: t('search.panel.anyone') }, { value: 'me', label: t('search.panel.me') }]
  const baseLabel = (sender: SenderOption) => {
    const room = parseRoomSender(sender.value)
    return sender.value !== '' && sender.value !== 'me' && !room && sender.label !== sender.value ? `${sender.label} · ${sender.value}` : sender.label
  }
  const saved = value && value !== 'me' && !summary && !senders.some(sender => sender.value === value)
    ? [{ value, label: parseRoomSender(value)?.nick ?? value }] : []
  const candidates = [...shortcuts, ...saved, ...senders].map(sender => ({ ...sender, label: baseLabel(sender) }))
  const counts = countLabels(candidates)
  const contextual = candidates.map(sender => {
    const room = parseRoomSender(sender.value)
    if (!room || counts.get(sender.label) === 1) return sender
    const status = saved.some(item => item.value === sender.value) ? ` · ${t('common.saved')}` : ''
    return { ...sender, label: `${sender.label} · ${room.room}${status}` }
  })
  const contextualCounts = countLabels(contextual)
  const labelled = contextual.map(sender => {
    const room = parseRoomSender(sender.value)
    return room && (contextualCounts.get(sender.label) ?? 0) > 1
      ? { ...sender, label: `${sender.label} · ${room.occupant || sender.value}` } : sender
  })
  const needle = normalize(query.trim())
  const matches = labelled.slice(shortcuts.length).filter(sender => normalize(`${sender.label} ${parseRoomSender(sender.value)?.nick ?? sender.value}`).includes(needle))
  const options = [...labelled.slice(0, shortcuts.length), ...matches]
  const highlighted = options.find(sender => sender.value === active)
  const current = summary ?? labelled.find(sender => sender.value === value)?.label ?? value
  // Fixed-width UTF-16 units preserve even malformed saved text without URI encoding errors.
  const optionId = (value: string) => `${id}-option-${value.split('').map(unit => unit.charCodeAt(0).toString(16).padStart(4, '0')).join('')}`
  const close = () => { setOpen(false); setQuery(''); setActive(null) }
  const closeAndFocus = () => { restoreFocus.current = true; close() }
  useCloseOnEscape(closeAndFocus, open)
  useLayoutEffect(() => {
    if (open) input.current?.focus()
    else if (restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus() }
  }, [open])
  const choose = (next: string) => { onChange(next); closeAndFocus() }
  const openPicker = () => { setQuery(''); setActive(null); setOpen(true) }
  const row = (sender: SenderOption) => <div
    key={sender.value}
    id={optionId(sender.value)}
    role="option"
    aria-selected={sender.value === value}
    onPointerMove={() => setActive(sender.value)}
    onMouseDown={event => event.preventDefault()}
    onClick={() => choose(sender.value)}
    className={`flex items-start gap-2 px-3 py-2 text-sm cursor-pointer break-words ${active === sender.value ? 'bg-fluux-brand/15 text-fluux-text' : 'text-fluux-text hover:bg-fluux-hover'}`}
  >
    <span className="min-w-0 flex-1">{sender.label}</span>
    {sender.value === value && <Check aria-hidden="true" className="size-4 flex-shrink-0 mt-0.5" />}
  </div>
  // Pointer focus changes must not move another form control before its click is activated.
  return <div className="space-y-1">
    <label id={`${id}-label`} htmlFor={open ? `${id}-input` : `${id}-trigger`} className="block text-sm font-medium text-fluux-text">{t('search.panel.from')}</label>
    <button ref={trigger} id={`${id}-trigger`} type="button" hidden={open}
      aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`}
      className={`${fieldClass} ${open ? 'hidden' : 'flex'} items-center gap-2 text-left`}
      onClick={openPicker} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openPicker() }
      }}>
      <span id={`${id}-value`} className="min-w-0 flex-1 break-words">{current}</span><ChevronDown aria-hidden="true" className="size-4 flex-shrink-0" />
    </button>
    {open && <>
      <div className="relative">
        <Search aria-hidden="true" className="absolute left-3 top-2.5 size-4 text-fluux-muted" />
        <TextInput ref={input} id={`${id}-input`} role="combobox" aria-autocomplete="list" aria-expanded="true"
          aria-controls={`${id}-list`} aria-activedescendant={highlighted ? optionId(highlighted.value) : undefined}
          autoComplete="off" placeholder={t('search.panel.senderPlaceholder')} value={query} className={`${fieldClass} pl-9`}
          onChange={event => { setQuery(event.target.value); setActive(null) }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
              // Composition keys belong to the input method, not the form or modal.
              event.stopPropagation()
              return
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const index = options.findIndex(sender => sender.value === active)
              const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
              setActive(options[next].value)
              document.getElementById(optionId(options[next].value))?.scrollIntoView({ block: 'nearest' })
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (highlighted) choose(highlighted.value)
            } else if (event.key === 'Tab') close()
          }} />
      </div>
      <div id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} className="rounded border border-fluux-border bg-fluux-bg overflow-hidden">
        {labelled.slice(0, shortcuts.length).map(row)}
        <div role="presentation" className="max-h-40 overflow-y-auto border-t border-fluux-border">
          {matches.map(row)}
        </div>
      </div>
    </>}
    <p role="status" aria-live="polite" aria-atomic="true" className={open && matches.length === 0 ? 'px-3 py-2 text-sm text-fluux-muted' : 'sr-only'}>{open && matches.length === 0 ? t('search.panel.noSenders') : ''}</p>
  </div>
}
