import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Settings } from 'lucide-react'
import type { AdminCommand } from '@fluux/sdk'

interface AdminActionsDropdownProps {
  commands: AdminCommand[]
  onSelectCommand: (node: string) => void
  disabled?: boolean
}

/**
 * Humanize a command node to a readable label.
 * e.g., "http://jabber.org/protocol/admin#delete-user" -> "Delete User"
 */
function humanizeCommandNode(node: string): string {
  // Extract the command name from the node
  const name = node.split('#').pop() || node
  // Convert kebab-case to Title Case
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function AdminActionsDropdown({
  commands,
  onSelectCommand,
  disabled = false,
}: AdminActionsDropdownProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Close on Escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      return () => document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen])

  const handleSelect = (node: string) => {
    setIsOpen(false)
    onSelectCommand(node)
  }

  if (commands.length === 0) {
    return null
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-bg hover:bg-fluux-hover
                   text-fluux-text rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                   border border-fluux-hover"
      >
        <Settings className="w-4 h-4" />
        <span>{t('admin.manageUser')}</span>
        <ChevronDown className={`w-4 h-4 ms-auto transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-fluux-sidebar border border-fluux-hover rounded-lg shadow-lg
                        py-1 max-h-64 overflow-y-auto">
          {commands.map((cmd) => (
            <button
              key={cmd.node}
              onClick={() => handleSelect(cmd.node)}
              className="w-full px-3 py-2 text-start text-sm text-fluux-text hover:bg-fluux-hover
                         transition-colors flex items-center gap-2"
            >
              <span>{cmd.name || humanizeCommandNode(cmd.node)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
