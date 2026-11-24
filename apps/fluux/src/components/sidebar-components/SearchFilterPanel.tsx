import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { localDayBounds, localDayValue, parseSearchFilters, parseRoomSender, type HasValue } from '@fluux/sdk'
import { ModalShell } from '../ModalShell'
import { TextInput } from '../ui/TextInput'
import { filterChipLabel, type SenderOption } from './searchOperators'

interface Props {
  filters: readonly string[]
  senders: readonly SenderOption[]
  onApply: (filters: string[]) => void
  onClose: () => void
}

const CONTENT_OPTIONS = ['image', 'link', 'file', 'poll'] as const
const fieldClass = 'w-full min-w-0 px-3 py-2 bg-fluux-bg text-fluux-text border border-fluux-border rounded text-sm'

export function SearchFilterPanel({ filters, senders, onApply, onClose }: Props) {
  const { t, i18n } = useTranslation()
  const initial = parseSearchFilters('', i18n.language, filters)
  const senderFilters = initial.filters.filter(filter => filter.op === 'from' || filter.op === 'is')
  const [edited, setEdited] = useState({ from: false, date: false, contains: false })
  const multipleSenders = senderFilters.length > 1
  const [from, setFrom] = useState(multipleSenders ? '__multiple' : initial.mine ? 'me' : initial.from[0] ?? '')
  const [contains, setContains] = useState<HasValue[]>(initial.has)
  const [date, setDate] = useState(initial.filters.some(filter => filter.range) ? 'custom' : '')
  const [start, setStart] = useState(initial.after !== undefined ? localDayValue(new Date(initial.after)) : '')
  const [end, setEnd] = useState(initial.before !== undefined ? localDayValue(new Date(initial.before - 1)) : '')
  const invalid = date === 'custom' && !!start && !!end && start > end
  const apply = () => {
    if (invalid) return
    const next: string[] = []
    if (!edited.from || (multipleSenders && from === '__multiple')) next.push(...senderFilters.map(filter => filter.raw))
    else if (from) next.push(`from:${JSON.stringify(from)}`)
    if (!edited.contains) next.push(...initial.filters.filter(filter => filter.op === 'has').map(filter => filter.raw))
    else for (const value of contains) next.push(`has:${value}`)
    const now = new Date()
    if (!edited.date) next.push(...initial.filters.filter(filter => !['from', 'is', 'has'].includes(filter.op)).map(filter => filter.raw))
    else if (date === 'custom') {
      if (start && end) next.push(`on:${start}..${end}`)
      else if (start || end) {
        const boundary = localDayBounds(start || end)?.start
        if (!boundary) return
        boundary.setDate(boundary.getDate() + (start ? -1 : 1))
        next.push(`${start ? 'after' : 'before'}:${localDayValue(boundary)}`)
      }
    } else if (date === 'today') next.push(`on:${localDayValue(now)}`)
    else if (date === 'yesterday') next.push(`on:${localDayValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))}`)
    else if (date === 'thisMonth') next.push(`on:${localDayValue(now).slice(0, 7)}`)
    else if (date === 'thisYear') next.push(`on:${now.getFullYear()}`)
    onApply(next)
    onClose()
  }
  return <ModalShell title={t('search.panel.title')} dialogLabel={t('search.panel.title')} onClose={onClose} align="top">
    <form className="p-4 space-y-4 overflow-y-auto" onSubmit={event => { event.preventDefault(); apply() }}>
      <div className="space-y-1">
        <label htmlFor="search-filter-from" className="block text-sm font-medium text-fluux-text">{t('search.panel.from')}</label>
        <select id="search-filter-from" className={fieldClass} value={from} onChange={event => { setFrom(event.target.value); setEdited(previous => ({ ...previous, from: true })) }}>
          <option value="">{t('search.panel.anyone')}</option>
          <option value="me">{t('search.panel.me')}</option>
          {multipleSenders && <option value="__multiple">{senderFilters.map(filter => filterChipLabel(filter, t, i18n.language)).join(' · ')}</option>}
          {from && from !== 'me' && !(multipleSenders && from === '__multiple') && !senders.some(sender => sender.value === from) && <option value={from}>{parseRoomSender(from)?.nick ?? from}</option>}
          {senders.map(sender => <option key={sender.value} value={sender.value}>{sender.label}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor="search-filter-date" className="block text-sm font-medium text-fluux-text">{t('search.panel.date')}</label>
        <select id="search-filter-date" className={fieldClass} value={date} onChange={event => { setDate(event.target.value); setEdited(previous => ({ ...previous, date: true })) }}>
          <option value="">{t('search.panel.anyTime')}</option>
          {['today', 'yesterday', 'thisMonth', 'thisYear'].map(preset => <option key={preset} value={preset}>{t(`search.dates.${preset}`)}</option>)}
          <option value="custom">{t('search.panel.custom')}</option>
        </select>
        {date === 'custom' && <div className="space-y-2 pt-2">
          <label className="block text-xs text-fluux-muted" htmlFor="search-filter-start">{t('search.panel.start')}</label>
          <TextInput id="search-filter-start" type="date" value={start} onChange={event => { setStart(event.target.value); setEdited(previous => ({ ...previous, date: true })) }} className={fieldClass} />
          <label className="block text-xs text-fluux-muted" htmlFor="search-filter-end">{t('search.panel.end')}</label>
          <TextInput id="search-filter-end" type="date" value={end} onChange={event => { setEnd(event.target.value); setEdited(previous => ({ ...previous, date: true })) }} className={fieldClass} />
          {invalid && <p role="alert" className="text-sm text-fluux-error">{t('search.panel.invalidRange')}</p>}
        </div>}
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-fluux-text">{t('search.panel.contains')}</legend>
        {CONTENT_OPTIONS.map(value => <label key={value} className="flex items-center gap-2 text-sm text-fluux-text min-h-8">
          <input type="checkbox" checked={contains.includes(value)} onChange={event => { setContains(event.target.checked ? [...contains, value] : contains.filter(item => item !== value)); setEdited(previous => ({ ...previous, contains: true })) }} className="accent-fluux-brand size-4" />
          {t(`search.panel.${value}`)}
        </label>)}
      </fieldset>
      <div className="flex flex-wrap justify-between gap-2 border-t border-fluux-border pt-3">
        <button type="button" className="text-sm text-fluux-muted hover:text-fluux-text px-2 py-2" onClick={() => { setFrom(''); setContains([]); setDate(''); setStart(''); setEnd(''); setEdited({ from: true, date: true, contains: true }) }}>{t('search.panel.clear')}</button>
        <button type="submit" disabled={invalid} className="px-4 py-2 text-sm rounded bg-fluux-brand text-fluux-text-on-accent disabled:opacity-50">{t('search.panel.apply')}</button>
      </div>
    </form>
  </ModalShell>
}
