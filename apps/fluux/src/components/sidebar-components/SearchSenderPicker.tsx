import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
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

const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
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
  const label = (sender: SenderOption) => {
    const room = parseRoomSender(sender.value)
    return sender.value !== '' && sender.value !== 'me' && !room && sender.label !== sender.value ? `${sender.label} · ${sender.value}` : sender.label
  }
  const saved = value && value !== 'me' && !summary && !senders.some(sender => sender.value === value)
    ? [{ value, label: parseRoomSender(value)?.nick ?? value }] : []
  const needle = normalize(query.trim())
  const matches = [...saved, ...senders].filter(sender => normalize(`${sender.label} ${parseRoomSender(sender.value)?.nick ?? sender.value}`).includes(needle))
  const options = [...shortcuts, ...matches]
  const selected = [...saved, ...senders].find(sender => sender.value === value)
  const current = summary ?? shortcuts.find(sender => sender.value === value)?.label
    ?? (selected ? label(selected) : value)
  const optionId = (value: string) => `${id}-option-${encodeURIComponent(value)}`
  const close = () => { setOpen(false); setQuery(''); setActive(null) }
  const closeAndFocus = () => { restoreFocus.current = true; close() }
  useCloseOnEscape(closeAndFocus, open)
  useLayoutEffect(() => {
    if (open) input.current?.focus()
    else if (restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus() }
  }, [open])
  useEffect(() => {
    if (active !== null) document.getElementById(`${id}-option-${encodeURIComponent(active)}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, id])
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
    <span className="min-w-0 flex-1">{label(sender)}</span>
    {sender.value === value && <Check aria-hidden="true" className="size-4 flex-shrink-0 mt-0.5" />}
  </div>
  return <div className="space-y-1" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) close()
  }}>
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
          aria-controls={`${id}-list`} aria-activedescendant={active !== null ? optionId(active) : undefined}
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
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (active !== null) choose(active)
            }
          }} />
      </div>
      <div id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} className="rounded border border-fluux-border bg-fluux-bg overflow-hidden">
        {shortcuts.map(row)}
        <div role="presentation" className="max-h-40 overflow-y-auto border-t border-fluux-border">
          {matches.map(row)}
        </div>
      </div>
      {matches.length === 0 && <p role="status" className="px-3 py-2 text-sm text-fluux-muted">{t('search.panel.noSenders')}</p>}
    </>}
  </div>
}
