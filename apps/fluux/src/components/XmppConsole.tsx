import React, { useState, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import { X, Trash2, Send, ChevronDown, ChevronUp, Search, Download, Server, ArrowDownToLine } from 'lucide-react'
import { useConsole, useXMPP, type XmppPacket } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { formatStanzaPreview, formatStanzaXml } from '@/utils/stanzaPreviewFormatter'
import { Tooltip } from './Tooltip'
import { isTauri } from '@/utils/tauri'

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

type FilterType = 'message' | 'presence' | 'iq' | 'sm' | 'other' | 'event'
type DirectionFilter = 'all' | 'incoming' | 'outgoing'

function getEntryFilterType(entry: XmppPacket): FilterType {
  // Events have their own filter
  if (entry.type === 'event') return 'event'

  // For packets, determine type from XML content
  const xml = entry.content.trim()
  if (xml.startsWith('<message')) return 'message'
  if (xml.startsWith('<presence')) return 'presence'
  if (xml.startsWith('<iq')) return 'iq'
  // Stream Management packets (XEP-0198)
  if (xml.startsWith('<r ') || xml.startsWith('<r>') ||
      xml.startsWith('<a ') || xml.startsWith('<a>') ||
      xml.startsWith('<enable') || xml.startsWith('<enabled') ||
      xml.startsWith('<resume') || xml.startsWith('<resumed') ||
      xml.startsWith('<failed')) return 'sm'
  return 'other'
}

interface ConsoleEntryProps {
  entry: XmppPacket
  isSelected: boolean
  expanded: boolean
  onToggle: () => void
  onSelect: () => void
}

function ConsoleEntry({ entry, isSelected, expanded, onToggle, onSelect }: ConsoleEntryProps) {
  const isEvent = entry.type === 'event'
  const isIncoming = entry.type === 'incoming'

  const selectedClass = isSelected ? 'bg-fluux-hover ring-1 ring-fluux-brand/50' : 'hover:bg-fluux-bg/30'

  // Different styling for events vs packets
  if (isEvent) {
    return (
      <div
        className={`${selectedClass} cursor-pointer border-l-4 border-l-orange-500`}
        onClick={onSelect}
      >
        <div className="flex items-start gap-2 px-3 py-1.5">
          <span className="text-fluux-muted text-xs font-mono whitespace-nowrap">
            [{format(entry.timestamp, 'HH:mm:ss.SSS')}]
          </span>
          <span className="font-mono text-orange-500">⚡</span>
          <span className="font-mono text-xs text-orange-600 dark:text-orange-400 flex-1">
            {entry.content}
          </span>
        </div>
      </div>
    )
  }

  const directionIcon = isIncoming ? '←' : '→'
  const directionColor = isIncoming ? 'text-blue-400' : 'text-green-400'
  const borderColor = isIncoming ? 'border-l-blue-500' : 'border-l-green-500'
  const stanzaPreview = formatStanzaPreview(entry.content)

  // Type badge colors
  const typeColors: Record<string, string> = {
    MSG: 'bg-purple-600',
    PRES: 'bg-teal-600',
    IQ: 'bg-orange-600',
    SM: 'bg-gray-600',
  }

  // Subtype badge colors for specific subtypes
  const subtypeColors: Record<string, string> = {
    error: 'bg-red-600',
    unavailable: 'bg-gray-500',
    subscribe: 'bg-yellow-600',
    subscribed: 'bg-green-600',
    unsubscribe: 'bg-orange-500',
    unsubscribed: 'bg-red-500',
  }

  return (
    <div className={`${selectedClass} border-l-4 ${borderColor}`}>
      <div
        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none"
        onClick={() => { onSelect(); onToggle(); }}
      >
        <span className="text-fluux-muted text-xs font-mono whitespace-nowrap">
          [{format(entry.timestamp, 'HH:mm:ss.SSS')}]
        </span>
        <span className={`font-mono ${directionColor}`}>{directionIcon}</span>

        {stanzaPreview ? (
          <>
            {/* Type badge */}
            <span className={`px-1.5 py-0.5 text-xs font-bold rounded ${typeColors[stanzaPreview.type] || 'bg-gray-600'} text-white`}>
              {stanzaPreview.type}
            </span>

            {/* Subtype */}
            <span className={`px-1.5 py-0.5 text-xs rounded ${subtypeColors[stanzaPreview.subtype] || 'bg-fluux-bg'} text-fluux-text`}>
              {stanzaPreview.subtype}
            </span>

            {/* From/To */}
            {(stanzaPreview.from || stanzaPreview.to) && (
              <span className="text-xs text-fluux-muted truncate max-w-[200px]">
                {stanzaPreview.from && <span className="text-fluux-text">{stanzaPreview.from}</span>}
                {stanzaPreview.from && stanzaPreview.to && <span className="mx-1">→</span>}
                {stanzaPreview.to && <span className="text-fluux-text">{stanzaPreview.to}</span>}
              </span>
            )}

            {/* Payloads or spacer - ensures chevron is always right-aligned */}
            <span className="text-xs text-fluux-muted flex-1 truncate">
              {stanzaPreview.payloads.length > 0 && `[${stanzaPreview.payloads.join(', ')}]`}
            </span>
          </>
        ) : (
          // Fallback to raw preview for unrecognized stanzas
          <span className={`font-mono text-xs flex-1 truncate ${isIncoming ? 'text-blue-300' : 'text-green-300'}`}>
            {entry.content.split('\n')[0]}
          </span>
        )}

        {expanded ? (
          <ChevronUp className="w-4 h-4 text-fluux-muted flex-shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-fluux-muted flex-shrink-0" />
        )}
      </div>
      {expanded && (
        <pre className="px-3 pb-2 text-xs font-mono text-fluux-text bg-fluux-bg/50 overflow-x-auto whitespace-pre">
          {formatStanzaXml(entry.content)}
        </pre>
      )}
    </div>
  )
}

export function XmppConsole() {
  const { t } = useTranslation()
  const { isOpen, height, entries, toggle, setHeight, clearEntries } = useConsole()
  // Use focused selectors instead of useConnection() to avoid re-renders when unrelated values change
  const status = useConnectionStore((s) => s.status)
  const serverInfo = useConnectionStore((s) => s.serverInfo)
  const connectionMethod = useConnectionStore((s) => s.connectionMethod)
  const { sendRawXml } = useXMPP()
  const [inputXml, setInputXml] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [showServerInfo, setShowServerInfo] = useState(false)
  const [enabledTypes, setEnabledTypes] = useState<Set<FilterType>>(
    new Set(['message', 'iq', 'sm', 'event'])
  )
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all')
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set())
  const [isResizing, setIsResizing] = useState(false)
  const [isResizeHover, setIsResizeHover] = useState(false)
  const packetsEndRef = useRef<HTMLDivElement>(null)
  const packetsContainerRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const selectedEntryRef = useRef<HTMLDivElement>(null)

  // Filter entries by type, direction, and search query
  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      // Filter by direction (events pass through all direction filters)
      if (entry.type !== 'event' && directionFilter !== 'all') {
        if (directionFilter !== entry.type) return false
      }

      // Filter by entry type
      const filterType = getEntryFilterType(entry)
      if (!enabledTypes.has(filterType)) return false

      // Filter by search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase()
        if (!entry.content.toLowerCase().includes(query)) return false
      }

      return true
    })
  }, [entries, searchQuery, enabledTypes, directionFilter])

  const toggleType = (type: FilterType) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        next.add(type)
      }
      return next
    })
  }

  const toggleEntryExpanded = (entryId: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev)
      if (next.has(entryId)) {
        next.delete(entryId)
      } else {
        next.add(entryId)
        // Scroll the expanded entry into view after DOM update
        requestAnimationFrame(() => {
          const entryElement = document.querySelector(`[data-entry-id="${entryId}"]`)
          entryElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        })
      }
      return next
    })
  }

  // Keyboard navigation for log entries
  const handleLogKeyDown = (e: React.KeyboardEvent) => {
    if (filteredEntries.length === 0) return

    const currentIndex = selectedEntryId
      ? filteredEntries.findIndex((entry) => entry.id === selectedEntryId)
      : -1

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (currentIndex < filteredEntries.length - 1) {
          const nextEntry = filteredEntries[currentIndex + 1]
          setSelectedEntryId(nextEntry.id)
          setAutoScroll(false)
        }
        break
      case 'ArrowUp':
        e.preventDefault()
        if (currentIndex > 0) {
          const prevEntry = filteredEntries[currentIndex - 1]
          setSelectedEntryId(prevEntry.id)
          setAutoScroll(false)
        } else if (currentIndex === -1 && filteredEntries.length > 0) {
          // Select last entry if none selected
          setSelectedEntryId(filteredEntries[filteredEntries.length - 1].id)
          setAutoScroll(false)
        }
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (selectedEntryId) {
          const entry = filteredEntries.find((e) => e.id === selectedEntryId)
          // Only toggle if it's not an event (events don't expand)
          if (entry && entry.type !== 'event') {
            toggleEntryExpanded(selectedEntryId)
          }
        }
        break
      case 'Escape':
        setSelectedEntryId(null)
        // Re-enable auto-scroll when exiting keyboard navigation
        if (packetsContainerRef.current) {
          const { scrollTop, scrollHeight, clientHeight } = packetsContainerRef.current
          const isAtBottom = scrollHeight - scrollTop - clientHeight < 50
          setAutoScroll(isAtBottom)
        }
        break
    }
  }

  // Scroll selected entry into view
  useEffect(() => {
    if (selectedEntryId && selectedEntryRef.current) {
      selectedEntryRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedEntryId])

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (isOpen && autoScroll && packetsEndRef.current) {
      packetsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [entries, autoScroll])

  // Scroll to bottom instantly when console opens and focus the log area
  useEffect(() => {
    if (isOpen) {
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        packetsEndRef.current?.scrollIntoView({ behavior: 'instant' })
        packetsContainerRef.current?.focus()
      })
    }
  }, [isOpen])

  // Auto-resize textarea based on content (1-8 lines)
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const lineHeight = 20 // approximate line height in px
    const minHeight = lineHeight * 1.2
    const maxHeight = lineHeight * 8
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`
  }, [inputXml])

  // Handle scroll to detect if user scrolled up
  const handleScroll = () => {
    if (!packetsContainerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = packetsContainerRef.current
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50
    setAutoScroll(isAtBottom)
  }

  // Resize handle
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    const startY = e.clientY
    const startHeight = height

    const handleMouseMove = (e: MouseEvent) => {
      const delta = startY - e.clientY
      const newHeight = Math.min(Math.max(startHeight + delta, 150), window.innerHeight - 200)
      setHeight(newHeight)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  const validateXml = (xml: string): string | null => {
    if (!xml.startsWith('<') || !xml.endsWith('>')) {
      return t('console.invalidXml')
    }
    // Use DOMParser to validate XML structure
    const parser = new DOMParser()
    const doc = parser.parseFromString(xml, 'application/xml')
    const parseError = doc.querySelector('parsererror')
    if (parseError) {
      return t('console.invalidXml')
    }
    return null
  }

  const handleSend = async () => {
    if (!inputXml.trim()) return

    setError(null)

    const trimmed = inputXml.trim()
    const validationError = validateXml(trimmed)
    if (validationError) {
      setError(validationError)
      return
    }

    try {
      await sendRawXml(trimmed)
      setInputXml('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('console.failedToSend'))
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleExport = async () => {
    // Build header with version info
    const exportDate = format(new Date(), 'yyyy-MM-dd HH:mm:ss')
    const header = [
      '================================================================================',
      `Fluux XMPP Console Log`,
      `Version: ${__APP_VERSION__} (${__GIT_COMMIT__})`,
      `Connection: ${connectionMethod?.toUpperCase() ?? 'Unknown'}`,
      `Exported: ${exportDate}`,
      '================================================================================',
    ]

    // Add server info section if available
    const serverSection: string[] = []
    if (serverInfo) {
      serverSection.push('')
      serverSection.push(`Server: ${serverInfo.domain}`)
      if (serverInfo.identities.length > 0) {
        const identity = serverInfo.identities[0]
        serverSection.push(`Identity: ${identity.name || 'Unknown'} (${identity.category}/${identity.type})`)
      }
      serverSection.push(`Features (${serverInfo.features.length}):`)
      for (const feature of serverInfo.features) {
        serverSection.push(`  - ${feature}`)
      }
      serverSection.push('')
      serverSection.push('================================================================================')
    }

    serverSection.push('')

    // Format entries as a readable log
    const lines = entries.map((entry) => {
      const timestamp = format(entry.timestamp, 'yyyy-MM-dd HH:mm:ss.SSS')
      if (entry.type === 'event') {
        return `[${timestamp}] EVENT: ${entry.content}`
      }
      const direction = entry.type === 'incoming' ? 'IN ' : 'OUT'
      return `[${timestamp}] ${direction}: ${entry.content}`
    })

    const content = [...header, ...serverSection, ...lines].join('\n')
    const defaultFilename = `xmpp-log-${format(new Date(), 'yyyy-MM-dd-HHmmss')}.txt`

    // Use native save dialog in Tauri, fallback to blob download for web
    if (isTauri()) {
      try {
        const { save } = await import('@tauri-apps/plugin-dialog')
        const { writeTextFile } = await import('@tauri-apps/plugin-fs')

        const filePath = await save({
          defaultPath: defaultFilename,
          filters: [{ name: 'Text Files', extensions: ['txt', 'log'] }],
        })

        if (filePath) {
          await writeTextFile(filePath, content)
        }
      } catch (err) {
        console.error('Failed to save file:', err)
        // Fallback to web download if Tauri save fails
        downloadAsBlob(content, defaultFilename)
      }
    } else {
      downloadAsBlob(content, defaultFilename)
    }
  }

  // Web fallback: download using blob URL
  const downloadAsBlob = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (!isOpen) return null

  const isConnected = status === 'online'

  return (
    <div
      className="bg-fluux-sidebar border-t border-fluux-bg flex flex-col flex-shrink-0"
      style={{ height }}
    >
      {/* Resize handle */}
      <div
        ref={resizeRef}
        className={`h-1 cursor-ns-resize transition-colors ${
          isResizing ? 'bg-fluux-brand/40' : isResizeHover ? 'bg-fluux-brand/20' : 'bg-fluux-bg'
        }`}
        onMouseDown={handleMouseDown}
        onMouseEnter={() => setIsResizeHover(true)}
        onMouseLeave={() => setIsResizeHover(false)}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-fluux-bg">
        <div className="flex items-center gap-4">
          <h3 className="font-semibold text-fluux-text">{t('console.title')}</h3>
          <span className="text-xs text-fluux-muted">
            {filteredEntries.length !== entries.length
              ? `${filteredEntries.length}/${entries.length}`
              : entries.length} entr{entries.length !== 1 ? 'ies' : 'y'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Direction filter */}
          <div className="flex items-center gap-0.5 border-r border-fluux-bg/50 pr-2">
            {(['all', 'incoming', 'outgoing'] as DirectionFilter[]).map((dir) => (
              <Tooltip key={dir} content={dir === 'all' ? t('console.showAll') : dir === 'incoming' ? t('console.showReceived') : t('console.showSent')} position="bottom">
                <button
                  onClick={() => setDirectionFilter(dir)}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    directionFilter === dir
                      ? dir === 'incoming' ? 'bg-blue-600 text-white' : dir === 'outgoing' ? 'bg-green-600 text-white' : 'bg-fluux-brand text-white'
                      : 'bg-fluux-bg/50 text-fluux-muted hover:text-fluux-text'
                  }`}
                >
                  {dir === 'all' ? '⇄' : dir === 'incoming' ? '←' : '→'}
                </button>
              </Tooltip>
            ))}
          </div>
          {/* Entry type filters */}
          <div className="flex items-center gap-1">
            {(['message', 'presence', 'iq', 'sm', 'other', 'event'] as FilterType[]).map((type) => (
              <Tooltip key={type} content={enabledTypes.has(type) ? t('console.hideType', { type: type === 'event' ? 'events' : type + ' packets' }) : t('console.showType', { type: type === 'event' ? 'events' : type + ' packets' })} position="bottom">
                <button
                  onClick={() => toggleType(type)}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    enabledTypes.has(type)
                      ? type === 'event' ? 'bg-orange-600 text-white' : 'bg-fluux-brand text-white'
                      : 'bg-fluux-bg/50 text-fluux-muted hover:text-fluux-text'
                  }`}
                >
                  {type}
                </button>
              </Tooltip>
            ))}
          </div>
          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fluux-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('console.filter')}
              className="w-32 pl-7 pr-2 py-1 text-xs bg-fluux-sidebar text-fluux-text rounded border border-fluux-bg/50 focus:outline-none focus:border-fluux-brand placeholder:text-fluux-muted"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fluux-muted hover:text-fluux-text"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <Tooltip content={t('console.serverInfo')} position="bottom">
            <button
              onClick={() => setShowServerInfo(true)}
              disabled={!serverInfo}
              className="p-1.5 text-fluux-muted hover:text-fluux-text hover:bg-fluux-bg/50 rounded disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={t('console.serverInfo')}
            >
              <Server className="w-4 h-4" />
            </button>
          </Tooltip>
          <Tooltip content={t('console.export')} position="bottom">
            <button
              onClick={handleExport}
              disabled={entries.length === 0}
              className="p-1.5 text-fluux-muted hover:text-fluux-text hover:bg-fluux-bg/50 rounded disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={t('console.export')}
            >
              <Download className="w-4 h-4" />
            </button>
          </Tooltip>
          <Tooltip content={t('console.clear')} position="bottom">
            <button
              onClick={clearEntries}
              className="p-1.5 text-fluux-muted hover:text-fluux-text hover:bg-fluux-bg/50 rounded"
              aria-label={t('console.clear')}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </Tooltip>
          <Tooltip content={t('console.close')} position="left">
            <button
              onClick={toggle}
              className="p-1.5 text-fluux-muted hover:text-fluux-text hover:bg-fluux-bg/50 rounded"
              aria-label={t('console.close')}
            >
              <X className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Entry list */}
      <div className="relative flex-1">
        <div
          ref={packetsContainerRef}
          tabIndex={0}
          className="xmpp-console-log absolute inset-0 overflow-y-auto overflow-x-hidden focus:outline-none focus:ring-2 focus:ring-inset focus:ring-fluux-brand/50"
          onScroll={handleScroll}
          onKeyDown={handleLogKeyDown}
        >
          {entries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-fluux-muted">
              {t('console.noEntries')}. {isConnected ? t('console.trafficWillAppear') : t('console.connectToSeeTraffic')}
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-fluux-muted">
              {t('console.noEntriesMatchFilters')}{searchQuery && ` "${searchQuery}"`}
            </div>
          ) : (
            <>
              {filteredEntries.map((entry) => (
                <div
                  key={entry.id}
                  ref={entry.id === selectedEntryId ? selectedEntryRef : undefined}
                  data-entry-id={entry.id}
                >
                  <ConsoleEntry
                    entry={entry}
                    isSelected={entry.id === selectedEntryId}
                    expanded={expandedEntries.has(entry.id)}
                    onToggle={() => toggleEntryExpanded(entry.id)}
                    onSelect={() => setSelectedEntryId(entry.id)}
                  />
                </div>
              ))}
              <div ref={packetsEndRef} />
            </>
          )}
        </div>

        {/* Floating "Go to Live" button */}
        {!autoScroll && filteredEntries.length > 0 && (
          <button
            onClick={() => {
              setAutoScroll(true)
              setSelectedEntryId(null)
              packetsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
            }}
            className="absolute bottom-4 right-4 flex items-center gap-2 px-3 py-2 bg-fluux-brand text-white text-sm font-medium rounded-full shadow-lg hover:bg-fluux-brand/90 transition-colors"
          >
            <ArrowDownToLine className="w-4 h-4" />
            {t('console.goToLive')}
          </button>
        )}
      </div>

      {/* Input area */}
      <div className="p-3">
        {error && (
          <div className="text-red-400 text-xs mb-2">{error}</div>
        )}
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={inputXml}
            onChange={(e) => setInputXml(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isConnected ? t('console.enterStanza', { modifier: isMac ? '⌘' : 'Ctrl' }) : t('console.connectToSend')}
            disabled={!isConnected}
            className="flex-1 bg-fluux-bg text-fluux-text text-sm font-mono px-3 py-2 rounded resize-none focus:outline-none focus:ring-1 focus:ring-fluux-brand disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden"
            rows={1}
          />
          <Tooltip content={t('console.sendStanza', { modifier: isMac ? '⌘' : 'Ctrl' })} position="top">
            <button
              onClick={handleSend}
              disabled={!isConnected || !inputXml.trim()}
              className="px-4 bg-fluux-brand text-white rounded hover:bg-fluux-brand/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-label={t('console.sendStanza', { modifier: isMac ? '⌘' : 'Ctrl' })}
            >
              <Send className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Server Info Modal */}
      {showServerInfo && serverInfo && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowServerInfo(false)}>
          <div
            className="bg-fluux-sidebar rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-fluux-bg">
              <div className="flex items-center gap-2">
                <Server className="w-5 h-5 text-fluux-brand" />
                <h2 className="text-lg font-semibold text-fluux-text">{t('console.serverInformation')}</h2>
              </div>
              <button
                onClick={() => setShowServerInfo(false)}
                className="p-1 text-fluux-muted hover:text-fluux-text rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Domain */}
              <div>
                <h3 className="text-sm font-medium text-fluux-muted mb-1">Domain</h3>
                <p className="text-fluux-text font-mono">{serverInfo.domain}</p>
              </div>

              {/* Identities */}
              {serverInfo.identities.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-fluux-muted mb-2">Identity</h3>
                  <div className="space-y-1">
                    {serverInfo.identities.map((identity, idx) => (
                      <div key={idx} className="text-fluux-text">
                        <span className="font-medium">{identity.name || 'Unknown'}</span>
                        <span className="text-fluux-muted ml-2">({identity.category}/{identity.type})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Features */}
              <div>
                <h3 className="text-sm font-medium text-fluux-muted mb-2">
                  Features ({serverInfo.features.length})
                </h3>
                <div className="bg-fluux-bg rounded p-3 max-h-64 overflow-y-auto">
                  <div className="grid gap-1">
                    {serverInfo.features.map((feature, idx) => (
                      <code key={idx} className="text-xs text-fluux-text font-mono break-all">
                        {feature}
                      </code>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-4 py-3 border-t border-fluux-bg flex justify-end">
              <button
                onClick={() => setShowServerInfo(false)}
                className="px-4 py-2 bg-fluux-bg text-fluux-text rounded hover:bg-fluux-bg/70 transition-colors"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
