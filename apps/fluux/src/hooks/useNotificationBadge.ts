import { useEffect, useRef } from 'react'
import { useEvents, computeBadgeCount } from '@fluux/sdk'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'
import { notificationDebug } from '@/utils/notificationDebug'

// Check if running in Tauri (v2 uses __TAURI_INTERNALS__)
const isTauri = () => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// Set Tauri dock/taskbar badge
async function setTauriBadge(count: number): Promise<void> {
  if (!isTauri()) return

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const window = getCurrentWindow()
    // Pass undefined to clear badge, number to set it
    await window.setBadgeCount(count > 0 ? count : undefined)
  } catch {
    // Badge API may not be available on all platforms
  }
}

// Browser favicon badge implementation
class FaviconBadge {
  private originalFavicon: string | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private faviconLink: HTMLLinkElement | null = null
  private faviconImage: HTMLImageElement | null = null
  private isReady = false

  constructor() {
    if (typeof document === 'undefined') return

    this.canvas = document.createElement('canvas')
    this.canvas.width = 32
    this.canvas.height = 32
    this.ctx = this.canvas.getContext('2d')

    // Find or create favicon link
    this.faviconLink = document.querySelector('link[rel="icon"]')
    if (!this.faviconLink) {
      this.faviconLink = document.createElement('link')
      this.faviconLink.rel = 'icon'
      document.head.appendChild(this.faviconLink)
    }

    // Store original favicon
    this.originalFavicon = this.faviconLink.href || '/favicon.png'

    // Load the original favicon image
    this.faviconImage = new Image()
    this.faviconImage.crossOrigin = 'anonymous'
    this.faviconImage.onload = () => {
      this.isReady = true
    }
    this.faviconImage.src = this.originalFavicon
  }

  setBadge(count: number): void {
    if (!this.ctx || !this.canvas || !this.faviconLink) return

    // Clear canvas
    this.ctx.clearRect(0, 0, 32, 32)

    // Draw original favicon if loaded
    if (this.isReady && this.faviconImage) {
      this.ctx.drawImage(this.faviconImage, 0, 0, 32, 32)
    } else {
      // Fallback: draw a simple icon
      this.ctx.fillStyle = '#5865F2'
      this.ctx.fillRect(0, 0, 32, 32)
    }

    // Draw badge if count > 0
    if (count > 0) {
      // Red circle
      this.ctx.beginPath()
      this.ctx.arc(24, 8, 8, 0, 2 * Math.PI)
      this.ctx.fillStyle = '#ED4245'
      this.ctx.fill()

      // Badge text
      if (count < 100) {
        this.ctx.fillStyle = '#FFFFFF'
        this.ctx.font = 'bold 10px sans-serif'
        this.ctx.textAlign = 'center'
        this.ctx.textBaseline = 'middle'
        this.ctx.fillText(count.toString(), 24, 9)
      }
    }

    // Update favicon
    this.faviconLink.href = this.canvas.toDataURL('image/png')
  }

  reset(): void {
    if (this.faviconLink && this.originalFavicon) {
      this.faviconLink.href = this.originalFavicon
    }
  }
}

/**
 * Hook to manage notification badges for unread messages and inbox events.
 * - In Tauri: Sets the dock/taskbar badge count
 * - In Browser: Updates the favicon with a notification indicator
 *
 * Badge count is a simple sum of store-maintained unread counts.
 * The stores keep unreadCounts accurate via onWindowBecameVisible transitions
 * (triggered by useWindowVisibility), so no independent focus tracking is needed.
 */
export function useNotificationBadge(): void {
  const { pendingCount: eventsPendingCount } = useEvents()
  const roomsWithUnreadCount = useRoomStore((s) => s.roomsWithUnreadCount())

  // Count conversations with unread messages
  const conversationsUnreadCount = useChatStore((s) => {
    let count = 0
    for (const conv of s.conversations.values()) {
      if (conv.unreadCount > 0) count++
    }
    return count
  })

  const faviconBadgeRef = useRef<FaviconBadge | null>(null)

  // Initialize favicon badge handler (browser only)
  useEffect(() => {
    if (!isTauri() && typeof document !== 'undefined') {
      faviconBadgeRef.current = new FaviconBadge()
    }

    return () => {
      faviconBadgeRef.current?.reset()
    }
  }, [])

  // Update badge when any unread count changes
  useEffect(() => {
    const totalCount = computeBadgeCount({
      conversationsUnreadCount,
      roomsWithUnreadCount,
      eventsPendingCount,
    })

    notificationDebug.dockBadge({
      count: totalCount,
      reason: 'badge-update',
      breakdown: {
        conversationsUnread: conversationsUnreadCount,
        eventsPending: eventsPendingCount,
        roomsUnread: roomsWithUnreadCount,
      },
    })

    if (isTauri()) {
      void setTauriBadge(totalCount)
    } else if (faviconBadgeRef.current) {
      faviconBadgeRef.current.setBadge(totalCount)
    }
  }, [conversationsUnreadCount, eventsPendingCount, roomsWithUnreadCount])
}
