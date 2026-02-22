import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Ban, Loader2, Plus, X } from 'lucide-react'
import { useBlocking, getLocalPart } from '@fluux/sdk'
import { Avatar } from '../Avatar'

export function BlockedUsersSettings() {
  const { t } = useTranslation()
  const { blockedJids, blockJid, unblockJid, unblockAll, fetchBlocklist } = useBlocking()
  const [searchQuery, setSearchQuery] = useState('')
  const [unblockingJid, setUnblockingJid] = useState<string | null>(null)
  const [showUnblockAllConfirm, setShowUnblockAllConfirm] = useState(false)
  const [isUnblockingAll, setIsUnblockingAll] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newJid, setNewJid] = useState('')
  const [isBlocking, setIsBlocking] = useState(false)
  const [blockError, setBlockError] = useState<string | null>(null)

  // Fetch blocklist on mount
  useEffect(() => {
    void fetchBlocklist()
  }, [fetchBlocklist])

  // Filter blocked JIDs by search query
  const filteredJids = useMemo(() => {
    if (!searchQuery.trim()) return blockedJids
    const query = searchQuery.toLowerCase()
    return blockedJids.filter(jid => jid.toLowerCase().includes(query))
  }, [blockedJids, searchQuery])

  const handleUnblock = async (jid: string) => {
    setUnblockingJid(jid)
    try {
      await unblockJid(jid)
    } catch (error) {
      console.error('[BlockedUsers] Failed to unblock:', error)
    } finally {
      setUnblockingJid(null)
    }
  }

  const handleUnblockAll = async () => {
    setIsUnblockingAll(true)
    try {
      await unblockAll()
      setShowUnblockAllConfirm(false)
    } catch (error) {
      console.error('[BlockedUsers] Failed to unblock all:', error)
    } finally {
      setIsUnblockingAll(false)
    }
  }

  const handleAddBlock = async () => {
    const jid = newJid.trim()
    if (!jid) return

    // Basic JID validation (must contain @)
    if (!jid.includes('@')) {
      setBlockError(t('settings.blocked.invalidJid'))
      return
    }

    // Check if already blocked
    if (blockedJids.includes(jid)) {
      setBlockError(t('settings.blocked.alreadyBlocked'))
      return
    }

    setIsBlocking(true)
    setBlockError(null)
    try {
      await blockJid(jid)
      setNewJid('')
      setShowAddForm(false)
    } catch (error) {
      console.error('[BlockedUsers] Failed to block:', error)
      setBlockError(t('settings.blocked.blockFailed'))
    } finally {
      setIsBlocking(false)
    }
  }

  const handleCancelAdd = () => {
    setShowAddForm(false)
    setNewJid('')
    setBlockError(null)
  }

  return (
    <section className="max-w-md">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.blocked.title')}
      </h3>

      <p className="text-sm text-fluux-muted mb-4">
        {t('settings.blocked.description')}
      </p>

      {/* Add block form */}
      {showAddForm ? (
        <div className="mb-4 p-3 rounded-lg border border-fluux-hover bg-fluux-bg">
          <div className="flex items-center gap-2 mb-2">
            <input
              type="text"
              value={newJid}
              onChange={(e) => {
                setNewJid(e.target.value)
                setBlockError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAddBlock()
                if (e.key === 'Escape') handleCancelAdd()
              }}
              placeholder={t('settings.blocked.jidPlaceholder')}
              autoFocus
              className="flex-1 px-3 py-2 rounded-lg border-2 border-fluux-hover bg-fluux-bg
                         text-fluux-text placeholder:text-fluux-muted
                         focus:border-fluux-brand focus:outline-none transition-colors"
            />
            <button
              onClick={handleAddBlock}
              disabled={isBlocking || !newJid.trim()}
              className="flex items-center gap-1.5 px-3 py-2 text-sm text-white
                         bg-fluux-red hover:bg-fluux-red/90 rounded-lg transition-colors
                         disabled:opacity-50"
            >
              {isBlocking ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Ban className="w-4 h-4" />
              )}
              {t('settings.blocked.block')}
            </button>
            <button
              onClick={handleCancelAdd}
              disabled={isBlocking}
              className="p-2 text-fluux-muted hover:text-fluux-text rounded-lg
                         hover:bg-fluux-hover transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {blockError && (
            <p className="text-sm text-fluux-red">{blockError}</p>
          )}
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center gap-2 w-full mb-4 p-3 rounded-lg border border-dashed
                     border-fluux-hover text-fluux-muted hover:text-fluux-text
                     hover:border-fluux-muted hover:bg-fluux-hover/50 transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('settings.blocked.addManually')}
        </button>
      )}

      {/* Search */}
      {blockedJids.length > 5 && (
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fluux-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('settings.blocked.searchPlaceholder')}
            className="w-full pl-10 pr-4 py-2 rounded-lg border-2 border-fluux-hover bg-fluux-bg
                       text-fluux-text placeholder:text-fluux-muted
                       focus:border-fluux-brand focus:outline-none transition-colors"
          />
        </div>
      )}

      {/* Blocked users list */}
      {blockedJids.length === 0 ? (
        <div className="text-center py-8">
          <Ban className="w-12 h-12 text-fluux-muted mx-auto mb-3 opacity-50" />
          <p className="text-fluux-muted">{t('settings.blocked.empty')}</p>
        </div>
      ) : (
        <div className="space-y-2 mb-4">
          {filteredJids.length === 0 && searchQuery ? (
            <p className="text-fluux-muted text-sm text-center py-4">
              {t('settings.blocked.noResults')}
            </p>
          ) : (
            filteredJids.map((jid) => (
              <BlockedUserItem
                key={jid}
                jid={jid}
                isUnblocking={unblockingJid === jid}
                onUnblock={() => handleUnblock(jid)}
              />
            ))
          )}
        </div>
      )}

      {/* Unblock All button */}
      {blockedJids.length > 1 && (
        <div className="pt-4 border-t border-fluux-hover">
          {showUnblockAllConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-fluux-muted flex-1">
                {t('settings.blocked.confirmUnblockAll', { count: blockedJids.length })}
              </span>
              <button
                onClick={() => setShowUnblockAllConfirm(false)}
                disabled={isUnblockingAll}
                className="px-3 py-1.5 text-sm text-fluux-muted hover:text-fluux-text
                           bg-fluux-hover rounded-md transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleUnblockAll}
                disabled={isUnblockingAll}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white
                           bg-fluux-red hover:bg-fluux-red/90 rounded-md transition-colors
                           disabled:opacity-50"
              >
                {isUnblockingAll && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('settings.blocked.unblockAll')}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowUnblockAllConfirm(true)}
              className="text-sm text-fluux-red hover:text-fluux-red/80 transition-colors"
            >
              {t('settings.blocked.unblockAll')} ({blockedJids.length})
            </button>
          )}
        </div>
      )}
    </section>
  )
}

interface BlockedUserItemProps {
  jid: string
  isUnblocking: boolean
  onUnblock: () => void
}

function BlockedUserItem({ jid, isUnblocking, onUnblock }: BlockedUserItemProps) {
  const { t } = useTranslation()
  const displayName = getLocalPart(jid)

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-fluux-hover bg-fluux-bg hover:bg-fluux-hover transition-colors">
      <Avatar
        identifier={jid}
        name={displayName}
        size="sm"
      />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-fluux-text truncate">{displayName}</p>
        <p className="text-xs text-fluux-muted truncate">{jid}</p>
      </div>
      <button
        onClick={onUnblock}
        disabled={isUnblocking}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-text
                   bg-fluux-hover hover:bg-fluux-muted/30 rounded-md transition-colors
                   disabled:opacity-50"
      >
        {isUnblocking ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          t('settings.blocked.unblock')
        )}
      </button>
    </div>
  )
}
