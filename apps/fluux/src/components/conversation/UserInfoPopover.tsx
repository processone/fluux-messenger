/**
 * Click-triggered user info popover for message view.
 * Shows useful contact info like JID and connected devices.
 * Dismisses on click outside.
 */
import { useState, useRef, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import type { Contact, ContactIdentity, RoomAffiliation, RoomRole, VCardInfo } from '@fluux/sdk'
import { useXMPP } from '@fluux/sdk'
import { useConnectionStore, useContactTime } from '@fluux/sdk/react'
import { useClickOutside } from '@/hooks'
import { getTranslatedShowText } from '@/utils/presence'
import { Monitor, Smartphone, Tablet, Globe, HelpCircle, Shield, Crown, UserCheck, Building2, Mail, MapPin, Clock, Loader2 } from 'lucide-react'

export interface UserInfoPopoverProps {
  /** The contact to show info for (Contact has device info, ContactIdentity is identity-only) */
  contact?: Contact | ContactIdentity
  /** The JID to display (fallback if no contact) */
  jid?: string
  /** Occupant JID for vCard fetch in anonymous rooms (e.g. room@conf/nick) */
  occupantJid?: string
  /** Room role (for MUC occupants) */
  role?: RoomRole
  /** Room affiliation (for MUC occupants) */
  affiliation?: RoomAffiliation
  /** Trigger element (avatar or name) */
  children: ReactNode
  /** Additional class for the trigger wrapper */
  className?: string
}

// Well-known XMPP clients categorized by platform
const MOBILE_CLIENTS = ['conversations', 'siskin', 'monal', 'beagle', 'chatsecure', 'yaxim', 'blabber', 'cheogram']
const DESKTOP_CLIENTS = ['dino', 'gajim', 'psi', 'swift', 'adium', 'pidgin', 'kopete', 'tkabber', 'profanity', 'mcabber']
const WEB_CLIENTS = ['movim', 'converse', 'jsxc', 'xmpp-web', 'libervia', 'salut', 'fluux']

/**
 * Get device icon based on client name heuristics
 */
function getDeviceIcon(clientName: string) {
  const name = clientName.toLowerCase()

  // Check well-known clients first
  if (MOBILE_CLIENTS.some(c => name.includes(c))) {
    return <Smartphone className="w-3 h-3" />
  }
  if (DESKTOP_CLIENTS.some(c => name.includes(c))) {
    return <Monitor className="w-3 h-3" />
  }
  if (WEB_CLIENTS.some(c => name.includes(c))) {
    return <Globe className="w-3 h-3" />
  }

  // Fall back to keyword-based detection
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

// Cache vCard results across popover opens to avoid redundant fetches
const vcardCache = new Map<string, VCardInfo | null>()

/** @internal Exported for testing only */
export const _vcardCacheForTesting = vcardCache

export function UserInfoPopover({ contact, jid, occupantJid, role, affiliation, children, className = '' }: UserInfoPopoverProps) {
  const { t } = useTranslation()
  const { client } = useXMPP()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState<{ x: number; top?: number; bottom?: number }>({ x: 0 })
  const [vcard, setVcard] = useState<VCardInfo | null>(null)
  const [vcardLoading, setVcardLoading] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useClickOutside(popoverRef, () => setIsOpen(false), isOpen)

  // Close on scroll (message list or any parent)
  useEffect(() => {
    if (!isOpen) return

    const handleScroll = () => setIsOpen(false)
    // Use capture to catch scroll events from any scrolling container
    window.addEventListener('scroll', handleScroll, true)
    return () => window.removeEventListener('scroll', handleScroll, true)
  }, [isOpen])

  // Fetch vCard when popover opens
  useEffect(() => {
    if (!isOpen) return

    const vcardJid = contact?.jid || jid || occupantJid
    if (!vcardJid) return

    // Check cache first
    if (vcardCache.has(vcardJid)) {
      setVcard(vcardCache.get(vcardJid) ?? null)
      return
    }

    let cancelled = false
    setVcardLoading(true)
    client.profile.fetchVCard(vcardJid).then((result) => {
      if (cancelled) return
      vcardCache.set(vcardJid, result)
      setVcard(result)
      setVcardLoading(false)
    }).catch(() => {
      if (cancelled) return
      vcardCache.set(vcardJid, null)
      setVcardLoading(false)
    })

    return () => { cancelled = true }
  }, [isOpen, contact?.jid, jid, occupantJid, client])

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isOpen) {
      setIsOpen(false)
      return
    }

    // Position the popover near the click
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      // Find the message list container to stay within its bounds
      const messageList = triggerRef.current?.closest('[data-message-list]')
      const listRect = messageList?.getBoundingClientRect()

      // Use message list bottom or leave 100px for typing area
      const maxBottom = listRect?.bottom ?? (window.innerHeight - 100)
      const popoverHeight = 150 // Estimated height

      // Position below if there's space, otherwise above
      const spaceBelow = maxBottom - rect.bottom - 8
      const positionAbove = spaceBelow < popoverHeight && rect.top > popoverHeight

      const x = Math.min(rect.left, window.innerWidth - 250) // Keep within viewport

      if (positionAbove) {
        // Position above: anchor bottom of popover to top of trigger
        setPosition({ x, bottom: window.innerHeight - rect.top + 8 })
      } else {
        // Position below: anchor top of popover to bottom of trigger
        setPosition({ x, top: rect.bottom + 8 })
      }
    }
    setIsOpen(true)
  }

  // Build device list (only available when contact has full Contact data with resources)
  const devices: { name: string; status: string; resource: string }[] = []
  if (contact && 'resources' in contact && contact.resources) {
    for (const [resource, presence] of contact.resources.entries()) {
      const clientName = presence.client || resource || t('contacts.unknown')
      const status = getTranslatedShowText(presence.show, t, forceOffline)
      devices.push({ name: clientName, status, resource })
    }
  }

  // Query entity time using the real JID (not occupant nick JID)
  // Only query when the popover is open to avoid unnecessary traffic
  const realJid = contact?.jid || jid
  const contactTime = useContactTime(isOpen && realJid ? realJid : null)

  const displayJid = realJid || (occupantJid?.split('/').pop())

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
          style={{ left: position.x, top: position.top, bottom: position.bottom }}
        >
          {/* JID */}
          {displayJid && (
            <div className="text-xs text-fluux-muted mb-2 break-all font-mono">
              {displayJid}
            </div>
          )}

          {/* vCard info */}
          {vcardLoading && (
            <div className="flex items-center gap-1.5 text-xs text-fluux-muted mb-2">
              <Loader2 className="w-3 h-3 animate-spin" />
            </div>
          )}
          {vcard && (
            <div className="space-y-1 mb-2">
              {vcard.fullName && (
                <div className="text-sm font-medium text-fluux-text">
                  {vcard.fullName}
                </div>
              )}
              {vcard.org && (
                <div className="flex items-center gap-1.5 text-xs text-fluux-muted">
                  <Building2 className="w-3 h-3 shrink-0" />
                  <span className="truncate">{vcard.org}</span>
                </div>
              )}
              {vcard.email && (
                <div className="flex items-center gap-1.5 text-xs text-fluux-muted">
                  <Mail className="w-3 h-3 shrink-0" />
                  <span className="truncate">{vcard.email}</span>
                </div>
              )}
              {vcard.country && (
                <div className="flex items-center gap-1.5 text-xs text-fluux-muted">
                  <MapPin className="w-3 h-3 shrink-0" />
                  <span className="truncate">{vcard.country}</span>
                </div>
              )}
            </div>
          )}

          {/* Local time (XEP-0202) */}
          {contactTime && (
            <div className="flex items-center gap-1.5 text-xs text-fluux-muted mb-2">
              <Clock className="w-3 h-3 shrink-0" />
              <span>{t('Local time')}: {contactTime}</span>
            </div>
          )}

          {/* Role & Affiliation (for room occupants) */}
          {(role || affiliation) && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {affiliation && affiliation !== 'none' && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-fluux-hover text-fluux-text">
                  {affiliation === 'owner' && <Crown className="w-3 h-3" />}
                  {affiliation === 'admin' && <Shield className="w-3 h-3" />}
                  {affiliation === 'member' && <UserCheck className="w-3 h-3" />}
                  {t(`rooms.${affiliation}`)}
                </span>
              )}
              {role && role !== 'none' && role !== 'participant' && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-fluux-hover text-fluux-text">
                  {t(`rooms.role.${role}`)}
                </span>
              )}
            </div>
          )}

          {/* Devices */}
          {devices.length > 0 && (
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
          )}
        </div>,
        document.body
      )}
    </>
  )
}
