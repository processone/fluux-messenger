import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, Mail, MapPin, Pencil, Plus, Trash2, User, type LucideIcon } from 'lucide-react'
import { type VCardInfo, useConnection } from '@fluux/sdk'
import { useClickOutside } from '@/hooks/useClickOutside'
import { TextInput } from '../../ui/TextInput'

type VCardKey = 'fullName' | 'org' | 'email' | 'country'

interface VCardField {
  key: VCardKey
  label: string
  icon: LucideIcon
}

export function VCardSection() {
  const { t } = useTranslation()
  const { isConnected, ownVCard, fetchOwnVCard, setOwnVCard } = useConnection()

  const [showAddField, setShowAddField] = useState(false)
  const [editingField, setEditingField] = useState<VCardKey | null>(null)
  const [editValue, setEditValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const addFieldRef = useRef<HTMLDivElement>(null)

  useClickOutside(addFieldRef, () => setShowAddField(false), showAddField)

  // Fetch own vCard on mount / when reconnected
  useEffect(() => {
    if (isConnected) void fetchOwnVCard()
  }, [isConnected, fetchOwnVCard])

  // Focus input when entering edit mode
  useEffect(() => {
    if (editingField) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editingField])

  const fields: VCardField[] = [
    { key: 'fullName', label: t('profile.fullName'), icon: User },
    { key: 'org', label: t('profile.company'), icon: Building2 },
    { key: 'email', label: t('profile.email'), icon: Mail },
    { key: 'country', label: t('profile.country'), icon: MapPin },
  ]

  const activeFields = fields.filter((f) => ownVCard?.[f.key])
  const availableFields = fields.filter((f) => !ownVCard?.[f.key])
  const editingNewField = editingField && !activeFields.find((f) => f.key === editingField)
    ? fields.find((f) => f.key === editingField) ?? null
    : null

  const handleStartEdit = (key: VCardKey) => {
    setEditValue(ownVCard?.[key] || '')
    setEditingField(key)
    setError(null)
  }

  const handleCancelEdit = () => {
    setEditingField(null)
    setEditValue('')
    setError(null)
  }

  const handleSave = async (key: VCardKey, value: string) => {
    const trimmed = value.trim()
    const newVCard: VCardInfo = { ...ownVCard }
    if (trimmed) {
      newVCard[key] = trimmed
    } else {
      delete newVCard[key]
    }
    setSaving(true)
    setError(null)
    try {
      await setOwnVCard(newVCard)
      setEditingField(null)
      setEditValue('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profile.vcardSaveError'))
    } finally {
      setSaving(false)
    }
  }

  const handleAddField = (key: VCardKey) => {
    setShowAddField(false)
    setEditValue('')
    setEditingField(key)
  }

  const handleKeyDown = (e: React.KeyboardEvent, key: VCardKey) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSave(key, editValue)
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }

  if (!isConnected) return null
  if (activeFields.length === 0 && !editingField && availableFields.length === 0) return null

  return (
    <section className="px-4 md:px-6 space-y-2">
      {(activeFields.length > 0 || editingField) && (
        <div className="rounded-lg bg-fluux-bg/40 py-1">
          {activeFields.map(({ key, label, icon: Icon }) => (
            <div key={key}>
              {editingField === key ? (
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <Icon className="size-4 text-fluux-muted flex-shrink-0" aria-hidden />
                  <TextInput
                    ref={inputRef}
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => handleKeyDown(e, key)}
                    onBlur={() => void handleSave(key, editValue)}
                    disabled={saving}
                    placeholder={label}
                    className="flex-1 text-sm text-fluux-text bg-fluux-bg rounded px-2 py-0.5
                               border border-fluux-brand focus:outline-none disabled:opacity-50"
                  />
                </div>
              ) : (
                <div className="group flex items-center gap-3 px-3 py-2.5">
                  <Icon className="size-4 text-fluux-muted flex-shrink-0" aria-hidden />
                  <span className="flex-1 text-sm text-fluux-text break-words">{ownVCard?.[key]}</span>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={() => handleStartEdit(key)}
                      className="p-0.5 text-fluux-muted hover:text-fluux-text rounded"
                      aria-label={t('profile.editNickname')}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSave(key, '')}
                      className="p-0.5 text-fluux-muted hover:text-fluux-error rounded"
                      aria-label={t('common.remove')}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {editingNewField && (() => {
            const Icon = editingNewField.icon
            return (
              <div className="flex items-center gap-3 px-3 py-2.5">
                <Icon className="size-4 text-fluux-muted flex-shrink-0" aria-hidden />
                <TextInput
                  ref={inputRef}
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e, editingNewField.key)}
                  onBlur={() => {
                    if (!editValue.trim()) {
                      handleCancelEdit()
                    } else {
                      void handleSave(editingNewField.key, editValue)
                    }
                  }}
                  disabled={saving}
                  placeholder={editingNewField.label}
                  className="flex-1 text-sm text-fluux-text bg-fluux-bg rounded px-2 py-0.5
                             border border-fluux-brand focus:outline-none disabled:opacity-50"
                />
              </div>
            )
          })()}
        </div>
      )}

      {error && <p className="text-xs text-fluux-error px-3">{error}</p>}

      {availableFields.length > 0 && !editingField && (
        <div ref={addFieldRef} className="relative">
          <button
            type="button"
            onClick={() => setShowAddField(!showAddField)}
            className="flex items-center gap-1 text-xs text-fluux-muted hover:text-fluux-text transition-colors"
          >
            <Plus className="size-3.5" />
            {t('profile.addField')}
          </button>
          {showAddField && (
            <div className="absolute top-full mt-1 start-0 bg-fluux-sidebar border border-fluux-hover rounded-lg shadow-lg py-1 z-10">
              {availableFields.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleAddField(key)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-fluux-text hover:bg-fluux-active transition-colors"
                >
                  <Icon className="size-4 text-fluux-muted" />
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
