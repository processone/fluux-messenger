/**
 * Sectioned room settings: a section list beside one section pane on desktop,
 * and a section list that drills into one section (with Back) on mobile.
 * Server form values are edited locally and submitted together on Save; the
 * notification mode is per-user and applies as soon as it is picked.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { DataForm, DataFormField, Room } from '@fluux/sdk'
import { AlertCircle, Award, ChevronLeft, ChevronRight, Image, Shield, Trash2, Users } from 'lucide-react'
import { TextInput, TextArea } from '../ui/TextInput'
import { Toggle } from '../ui/Toggle'
import { Select } from '../ui/Select'
import { SettingsGroup } from '../ui/SettingsGroup'
import { SettingsRow } from '../ui/SettingsRow'
import { useDataFormState } from '../DataFormFields'
import { RoomAvatar } from '../RoomAvatar'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import type { HeaderActionGroup } from '../header/headerOverflow'
import { SECTIONS, groupFields, isTrue, type RoomSettingsSectionId, type PlacedField } from './roomConfigSections'

/** Room actions that live in their own dialogs; the settings link to them. */
export interface RoomSettingsActions {
  notifyGroup?: HeaderActionGroup
  onAvatar?: () => void
  onMembers?: () => void
  onHats?: () => void
  onBulkModeration?: () => void
}

interface RoomSettingsPanelProps extends RoomSettingsActions {
  room: Room
  form: DataForm
  subject: string
  onSubjectChange: (value: string) => void
  onSave: (values: Record<string, string | string[]>) => void
  onClose: () => void
  saving: boolean
  saveError: string | null
  isOwner: boolean
  onDestroyClick: () => void
}

const inputClass = 'w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text placeholder-fluux-muted disabled:opacity-50'

/** Arrow keys move through a radio group (wrapping), Home and End jump to its ends. Returns the new index, or null. */
function radioKey(e: KeyboardEvent, index: number, count: number): number | null {
  const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? index + 1
    : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? index - 1
    : e.key === 'Home' ? 0
    : e.key === 'End' ? count - 1
    : null
  if (next === null) return null
  e.preventDefault()
  const wrapped = (next + count) % count
  ;(e.currentTarget.parentElement?.children[wrapped] as HTMLElement | undefined)?.focus()
  return wrapped
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Single choice: a segmented radiogroup for up to 3 short options, a select otherwise. */
function Choice({ id, field, value, onChange, disabled, labelledBy }: {
  id: string; field: DataFormField; value: string; onChange: (v: string) => void; disabled?: boolean; labelledBy: string
}) {
  const options = field.options ?? []
  const segmented = options.length > 0 && options.length <= 3 && options.every(o => (o.label || o.value).length <= 18)
  if (!segmented) {
    return (
      <Select id={id} value={value} onChange={e => onChange(e.target.value)} disabled={disabled} aria-labelledby={labelledBy} className="!py-1.5 !px-3 !pe-9 text-sm !border">
        {options.map(o => <option key={o.value} value={o.value}>{capitalize(o.label || o.value)}</option>)}
      </Select>
    )
  }
  // Keep one option tabbable even when the value matches none of them.
  const tabbable = Math.max(0, options.findIndex(o => o.value === value))
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="inline-flex rounded-lg bg-fluux-bg border border-fluux-border p-0.5">
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} tabIndex={i === tabbable ? 0 : -1} disabled={disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={e => { const n = radioKey(e, i, options.length); if (n !== null) onChange(options[n].value) }}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${on ? 'bg-fluux-brand text-fluux-text-on-accent' : 'text-fluux-muted hover:text-fluux-text'}`}>
            {capitalize(o.label || o.value)}
          </button>
        )
      })}
    </div>
  )
}

/** Multiple choice: toggle chips. */
function Chips({ field, value, onChange, disabled, labelledBy }: {
  field: DataFormField; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; labelledBy: string
}) {
  return (
    <div role="group" aria-labelledby={labelledBy} className="flex flex-wrap gap-1.5">
      {(field.options ?? []).map(o => {
        const on = value.includes(o.value)
        return (
          <button key={o.value} type="button" aria-pressed={on} disabled={disabled}
            onClick={() => onChange(on ? value.filter(v => v !== o.value) : [...value, o.value])}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${on ? 'border-fluux-brand bg-fluux-brand/15 text-fluux-text' : 'border-fluux-border text-fluux-muted hover:text-fluux-text'}`}>
            {on && <span aria-hidden="true">✓ </span>}{capitalize(o.label || o.value)}
          </button>
        )
      })}
    </div>
  )
}

function FieldRow({ placed, value, onChange, disabled }: {
  placed: PlacedField; value: string | string[] | undefined; onChange: (v: string | string[]) => void; disabled?: boolean
}) {
  const { t } = useTranslation()
  const { field, labelKey } = placed
  const label = labelKey ? t(`rooms.settings.fields.${labelKey}`) : field.label || field.var
  const id = `rs-${field.var}`
  const labelId = `${id}-label`
  const hint = field.desc || t(`dataFormHints.${field.var}`, { defaultValue: '' }) || undefined
  const text = typeof value === 'string' ? value : ''

  switch (field.type) {
    case 'fixed':
      return <p className="px-4 py-3 text-sm text-fluux-muted">{field.value || field.label}</p>
    case 'boolean':
      return (
        <SettingsRow label={label} description={hint} htmlFor={id}>
          <Toggle id={id} checked={isTrue(value)} onChange={v => onChange(v ? '1' : '0')} disabled={disabled} />
        </SettingsRow>
      )
    case 'list-single':
      return (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <div className="min-w-0 flex-1 basis-60">
            <p id={labelId} className="text-sm text-fluux-text">{label}</p>
            {hint && <p className="text-xs text-fluux-muted mt-0.5">{hint}</p>}
          </div>
          <div className="flex-shrink-0 min-w-36">
            <Choice id={id} field={field} value={text} onChange={onChange} disabled={disabled} labelledBy={labelId} />
          </div>
        </div>
      )
    case 'list-multi':
      return (
        <div className="px-4 py-3 space-y-2">
          <div>
            <p id={labelId} className="text-sm text-fluux-text">{label}</p>
            {hint && <p className="text-xs text-fluux-muted mt-0.5">{hint}</p>}
          </div>
          <Chips field={field} value={Array.isArray(value) ? value : []} onChange={onChange} disabled={disabled} labelledBy={labelId} />
        </div>
      )
    default: {
      const multi = field.type === 'text-multi' || field.type === 'jid-multi'
      return (
        <div className="px-4 py-3 space-y-1.5">
          <label htmlFor={id} className="block text-sm text-fluux-text">{label}</label>
          {multi ? (
            <TextArea id={id} rows={3} value={Array.isArray(value) ? value.join('\n') : text}
              onChange={e => onChange(e.target.value.split('\n'))} disabled={disabled}
              placeholder={field.type === 'jid-multi' ? t('admin.oneJidPerLine') : t('admin.onePerLine')} className={`${inputClass} resize-y`} />
          ) : (
            <TextInput id={id} type={field.type === 'text-private' ? 'password' : 'text'} value={text}
              onChange={e => onChange(e.target.value)} disabled={disabled} required={field.required} className={inputClass} />
          )}
          {hint && <p className="text-xs text-fluux-muted">{hint}</p>}
        </div>
      )
    }
  }
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-fluux-muted px-1">{title}</h4>
      <SettingsGroup>{children}</SettingsGroup>
    </div>
  )
}

function LinkRow({ label, description, icon: Icon, onClick, disabled }: {
  label: string; description: string; icon: typeof Users; onClick: () => void; disabled?: boolean
}) {
  return (
    <SettingsRow label={label} description={description} onClick={onClick} disabled={disabled}>
      <span className="flex items-center gap-2 text-fluux-muted"><Icon className="size-4" /><ChevronRight className="size-4 rtl-mirror" /></span>
    </SettingsRow>
  )
}

export function RoomSettingsPanel({
  room, form, subject, onSubjectChange, onSave, onClose, saving, saveError, isOwner, onDestroyClick,
  notifyGroup, onAvatar, onMembers, onHats, onBulkModeration,
}: RoomSettingsPanelProps) {
  const { t } = useTranslation()
  const { formData, handleChange, getSubmitValues } = useDataFormState(form)
  // The values the form opened with, to mark sections holding unsaved edits.
  const [initialData] = useState(formData)
  const groups = groupFields(form.fields)
  const desktop = useIsDesktop()

  const hasPeople = !!(onMembers || onHats || onBulkModeration)
  const sections = SECTIONS.filter(s => {
    switch (s.id) {
      case 'general': return true
      case 'notifications': return !!notifyGroup
      case 'danger': return isOwner
      case 'moderation': return groups.has(s.id) || hasPeople
      default: return groups.has(s.id)
    }
  })

  const dirty = new Set<RoomSettingsSectionId>()
  if (subject !== (room.subject || '')) dirty.add('general')
  for (const [section, sectionGroups] of groups) {
    const changed = sectionGroups.some(g => g.fields.some(p =>
      JSON.stringify(formData[p.field.var]) !== JSON.stringify(initialData[p.field.var])))
    if (changed) dirty.add(section)
  }

  // Dependent fields hide while their switch is off, but keep their value in the submitted form.
  const isShown = (p: PlacedField) => !p.dependsOn || !(p.dependsOn in formData) || isTrue(formData[p.dependsOn])

  const renderServerGroups = (id: RoomSettingsSectionId) => (groups.get(id) ?? []).map(g => {
    const shown = g.fields.filter(isShown)
    if (!shown.length) return null
    return (
      <Group key={g.id} title={t(`rooms.settings.groups.${g.id}`)}>
        {shown.map(p => (
          <FieldRow key={p.field.var} placed={p} value={formData[p.field.var]} onChange={v => handleChange(p.field.var, v)} disabled={saving} />
        ))}
      </Group>
    )
  })

  const renderSection = (id: RoomSettingsSectionId): ReactNode => {
    switch (id) {
      case 'general':
        return (
          <>
            <div className="flex flex-wrap items-center gap-4">
              <RoomAvatar identifier={room.jid} name={room.name} avatarUrl={room.avatar} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="text-base font-semibold text-fluux-text truncate">{room.name}</p>
                <p className="text-xs text-fluux-muted truncate">{room.jid}</p>
              </div>
              {onAvatar && (
                <button type="button" onClick={onAvatar}
                  className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-fluux-border text-fluux-text hover:bg-fluux-hover`}>
                  <Image className="size-4" />{t('rooms.changeAvatar')}
                </button>
              )}
            </div>
            <Group title={t('rooms.topic')}>
              <div className="px-4 py-3 space-y-1.5">
                <label htmlFor="rs-subject" className="block text-sm text-fluux-text">{t('rooms.settings.currentTopic')}</label>
                <TextArea id="rs-subject" rows={2} value={subject} onChange={e => onSubjectChange(e.target.value)} disabled={saving}
                  placeholder={t('rooms.settings.noTopic')} className={`${inputClass} resize-y`} />
                <p className="text-xs text-fluux-muted">{t('rooms.settings.topicHint')}</p>
              </div>
            </Group>
            {renderServerGroups(id)}
          </>
        )
      case 'notifications':
        return notifyGroup && (
          <Group title={t('rooms.settings.groups.notifyMe')}>
            <div role="radiogroup" aria-label={t('rooms.settings.groups.notifyMe')}>
              {notifyGroup.items.map((item, i) => {
                const Icon = item.icon
                const tabbable = Math.max(0, notifyGroup.items.findIndex(x => x.active))
                return (
                  <button key={item.key} type="button" role="radio" aria-checked={!!item.active} tabIndex={i === tabbable ? 0 : -1}
                    onClick={item.onSelect}
                    onKeyDown={e => { const n = radioKey(e, i, notifyGroup.items.length); if (n !== null) notifyGroup.items[n].onSelect() }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-start fluux-card-row-hover focus-ring-inset">
                    <Icon className={`size-4 flex-shrink-0 ${item.active ? 'text-fluux-brand' : 'text-fluux-muted'}`} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-fluux-text">{item.label}</span>
                      {item.description && <span className="block text-xs text-fluux-muted">{item.description}</span>}
                    </span>
                    <span aria-hidden="true" className={`flex items-center justify-center size-4 rounded-full border-2 ${item.active ? 'border-fluux-brand' : 'border-fluux-border'}`}>
                      {item.active && <span className="size-2 rounded-full bg-fluux-brand" />}
                    </span>
                  </button>
                )
              })}
            </div>
          </Group>
        )
      case 'moderation':
        return (
          <>
            {renderServerGroups(id)}
            {hasPeople && (
              <Group title={t('rooms.settings.groups.people')}>
                {onMembers && <LinkRow label={t('rooms.manageMembership')} description={t('rooms.settings.membersDesc')} icon={Users} onClick={onMembers} />}
                {onHats && (
                  <LinkRow label={t('rooms.manageHats')} description={room.supportsHats ? t('rooms.manageHatsDesc') : t('rooms.hatsNotEnabled')}
                    icon={Award} onClick={onHats} disabled={!room.supportsHats} />
                )}
                {onBulkModeration && <LinkRow label={t('rooms.bulkModeration')} description={t('rooms.settings.bulkModerationDesc')} icon={Shield} onClick={onBulkModeration} />}
              </Group>
            )}
          </>
        )
      case 'danger':
        return (
          <div className="rounded-lg border border-red-500/40 bg-red-500/5">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 basis-60">
                <p className="text-sm text-fluux-text">{t('rooms.settings.destroyTitle')}</p>
                <p className="text-xs text-fluux-muted">{t('rooms.destroyRoomConfirm')}</p>
              </div>
              <button type="button" onClick={onDestroyClick} disabled={saving}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm text-red-400 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg disabled:opacity-50`}>
                <Trash2 className="size-4" />{t('rooms.destroyRoom')}
              </button>
            </div>
          </div>
        )
      default:
        return renderServerGroups(id)
    }
  }

  const submit = (e: React.FormEvent) => { e.preventDefault(); onSave(getSubmitValues()) }

  return (
    <form onSubmit={submit} className="flex flex-col flex-1 min-h-0">
      <SectionBrowser sections={sections} dirty={dirty} desktop={desktop} renderSection={renderSection} />
      {saveError && (
        <div role="alert" className="mx-4 mb-2 flex items-start gap-2 p-3 rounded-lg border bg-red-500/10 border-red-500/30 text-red-400">
          <AlertCircle className="size-4 flex-shrink-0 mt-0.5" />
          <p className="text-sm">{saveError}</p>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-fluux-hover flex-shrink-0">
        <p className="text-xs text-fluux-muted hidden sm:block">{t('rooms.settings.footer')}</p>
        <div className="flex gap-2 ms-auto">
          <button type="button" onClick={onClose} disabled={saving}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-bg hover:bg-fluux-hover rounded-lg transition-colors disabled:opacity-50">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={saving}
            className="px-4 py-2 text-sm text-fluux-text-on-accent bg-fluux-brand hover:bg-fluux-brand/90 rounded-lg transition-colors disabled:opacity-50">
            {saving ? t('rooms.savingSettings') : t('rooms.saveSettings')}
          </button>
        </div>
      </div>
    </form>
  )
}

/** Section list plus one section pane (desktop), or list then drill-in with Back (mobile). */
function SectionBrowser({ sections, dirty, desktop, renderSection }: {
  sections: typeof SECTIONS; dirty: Set<RoomSettingsSectionId>; desktop: boolean; renderSection: (id: RoomSettingsSectionId) => ReactNode
}) {
  const { t } = useTranslation()
  const [active, setActive] = useState<RoomSettingsSectionId | null>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Where focus goes once the next section (or the list) renders: its heading, or the list row we came back from.
  const pendingFocus = useRef<'heading' | RoomSettingsSectionId | null>(null)

  const currentId = active ?? (desktop ? 'general' : null)
  const current = sections.find(s => s.id === currentId)

  useEffect(() => {
    const target = pendingFocus.current
    pendingFocus.current = null
    if (target === 'heading') headingRef.current?.focus()
    else if (target) navRef.current?.querySelector<HTMLElement>(`[data-rs-section="${target}"]`)?.focus()
  }, [currentId])

  const open = (id: RoomSettingsSectionId) => {
    paneRef.current?.scrollTo({ top: 0 })
    if (id === currentId) { headingRef.current?.focus(); return }
    pendingFocus.current = 'heading'
    setActive(id)
  }
  const back = () => {
    pendingFocus.current = currentId
    setActive(null)
  }

  const nav = (
    <nav ref={navRef} aria-label={t('rooms.settings.sectionsLabel')}
      className={desktop ? 'w-56 flex-shrink-0 border-e border-fluux-hover p-2 overflow-y-auto' : 'flex-1 overflow-y-auto p-4'}>
      <div className={desktop ? 'space-y-0.5' : 'fluux-card divide-y divide-[color:var(--fluux-surface-divider)] overflow-hidden'}>
        {sections.map(s => {
          const Icon = s.icon
          const on = desktop && s.id === currentId
          const danger = s.id === 'danger'
          const label = t(`rooms.settings.sections.${s.id}.label`)
          const dot = dirty.has(s.id) && (
            <span className="size-2 rounded-full bg-fluux-brand flex-shrink-0" title={t('rooms.settings.unsaved')}>
              <span className="sr-only">{t('rooms.settings.unsaved')}</span>
            </span>
          )
          return (
            <button key={s.id} type="button" data-rs-section={s.id} aria-current={on ? 'page' : undefined} onClick={() => open(s.id)}
              className={desktop
                ? `w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-start transition-colors ${on ? 'bg-fluux-brand/15 text-fluux-text font-medium' : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text'} ${danger ? '!text-red-400 mt-3' : ''}`
                : 'w-full flex items-center gap-3 px-4 py-3 text-start fluux-card-row-hover focus-ring-inset '}>
              <Icon className={`size-4 flex-shrink-0 ${danger ? 'text-red-400' : on ? 'text-fluux-brand' : 'text-fluux-muted'}`} />
              {desktop ? (
                <><span className="flex-1 min-w-0 truncate">{label}</span>{dot}</>
              ) : (
                <>
                  <span className="flex-1 min-w-0">
                    <span className={`block text-sm ${danger ? 'text-red-400' : 'text-fluux-text'}`}>{label}</span>
                    <span className="block text-xs text-fluux-muted truncate">{t(`rooms.settings.sections.${s.id}.description`)}</span>
                  </span>
                  {dot}
                  <ChevronRight className="size-4 text-fluux-muted rtl-mirror" />
                </>
              )}
            </button>
          )
        })}
      </div>
    </nav>
  )

  if (!current) return nav
  return (
    <div className="flex flex-1 min-h-0">
      {desktop && nav}
      <div ref={paneRef} className="flex-1 min-w-0 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
        {!desktop && (
          <button type="button" data-rs-back onClick={back} className={`flex items-center gap-1 -ms-1 mb-3 text-sm text-fluux-brand rounded`}>
            <ChevronLeft className="size-4 rtl-mirror" />{t('common.back')}
          </button>
        )}
        <section aria-labelledby={`rs-h-${current.id}`} className="space-y-5 max-w-2xl">
          <div>
            <h3 ref={headingRef} id={`rs-h-${current.id}`} tabIndex={-1}
              className={`text-lg font-semibold ${current.id === 'danger' ? 'text-red-400' : 'text-fluux-text'}`}>
              {t(`rooms.settings.sections.${current.id}.label`)}
            </h3>
            <p className="text-sm text-fluux-muted">{t(`rooms.settings.sections.${current.id}.description`)}</p>
          </div>
          {renderSection(current.id)}
        </section>
      </div>
    </div>
  )
}
