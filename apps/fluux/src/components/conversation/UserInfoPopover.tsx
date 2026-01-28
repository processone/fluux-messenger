/**
 * Click-triggered user info popover for message view.
 * Shows useful contact info like JID and connected devices.
 * Dismisses on click outside.
 */
import { useState, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import type { Contact } from '@fluux/sdk'
import { useClickOutside } from '@/hooks'
import { getTranslatedShowText } from '@/utils/presence'
import { Monitor, Smartphone, Tablet, Globe, HelpCircle } from 'lucide-react'

export interface UserInfoPopoverProps {
  /** The contact to show info for */
  contact?: Contact
  /** The JID to display (fallback if no contact) */
  jid?: string
  /** Trigger element (avatar or name) */
  children: ReactNode
  /** Additional class for the trigger wrapper */
  className?: string
}

/**
 * Get device icon based on client name heuristics
 */
function getDeviceIcon(clientName: string) {
  const name = clientName.toLowerCase()
  if (name.includes('mobile') || name.includes('android') || name.includes('ios') || name.includes('iphone')) {
    return <Smartphone className="w-3 h-3" />
  }
  if (name.includes('tablet') || name.includes('ipad')) {
    return <Tablet className="w-3 h-3" />
  }
  if (name.includes('web') || name.includes('browser')) {
    return <Globe className="w-3 h-3" />
  }
  if (name.includes('desktop') || name.includes('pc') || name.includes('mac') || name.includes('linux') || name.includes('windows')) {
    return <Monitor className="w-3 h-3" />
  }
  return <HelpCircle className="w-3 h-3" />
}

export function UserInfoPopover({ contact, jid, children, className = '' }: UserInfoPopoverProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const triggerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useClickOutside(popoverRef, () => setIsOpen(false), isOpen)

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isOpen) {
      setIsOpen(false)
      return
    }

    // Position the popover near the click
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      // Position below and slightly to the right of the trigger
      setPosition({
        x: Math.min(rect.left, window.innerWidth - 250), // Keep within viewport
        y: rect.bottom + 8,
      })
    }
    setIsOpen(true)
  }

  // Build device list
  const devices: { name: string; status: string; resource: string }[] = []
  if (contact?.resources) {
    for (const [resource, presence] of contact.resources.entries()) {
      const clientName = presence.client || resource || t('contacts.unknown')
      const status = getTranslatedShowText(presence.show, t)
      devices.push({ name: clientName, status, resource })
    }
  }

  const displayJid = contact?.jid || jid

  return (
    <>
      <div
        ref={triggerRef}
        onClick={handleClick}
        className={`cursor-pointer ${className}`}
      >
        {children}
      </div>

      {isOpen && createPortal(
        <div
          ref={popoverRef}
          className="fixed bg-fluux-sidebar rounded-lg shadow-xl border border-fluux-hover p-3 z-50 min-w-[200px] max-w-[280px]"
          style={{ left: position.x, top: position.y }}
        >
          {/* JID */}
          {displayJid && (
            <div className="text-xs text-fluux-muted mb-2 break-all font-mono">
              {displayJid}
            </div>
          )}

          {/* Devices */}
          {devices.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-fluux-text">
                {t('contacts.connectedDevices')}
              </div>
              {devices.map((device, index) => (
                <div
                  key={device.resource || index}
                  className="flex items-center gap-2 text-sm text-fluux-text"
                >
                  <span className="text-fluux-muted">
                    {getDeviceIcon(device.name)}
                  </span>
                  <span className="flex-1 truncate">{device.name}</span>
                  <span className="text-xs text-fluux-muted">{device.status}</span>
                </div>
              ))}
            </div>
          ) : contact ? (
            <div className="text-sm text-fluux-muted">
              {t('contacts.offline')}
            </div>
          ) : null}
        </div>,
        document.body
      )}
    </>
  )
}
