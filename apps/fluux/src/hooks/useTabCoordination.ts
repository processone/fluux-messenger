/**
 * Tab Coordination via BroadcastChannel
 *
 * Prevents multiple browser tabs from connecting simultaneously with the same JID.
 * Uses leader election: one tab holds the XMPP connection, others show a takeover screen.
 *
 * - Skipped entirely on Tauri (desktop app)
 * - Uses the xmpp-resource from sessionStorage as stable tab identity (survives reload)
 * - Stale tab detection: 500ms timeout on CLAIM — if no ALIVE response, tab is dead
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { isTauri } from '@/utils/tauri'
import { getResource } from '@/utils/xmppResource'

const CHANNEL_NAME = 'fluux-tab-coordination'
const CLAIM_TIMEOUT_MS = 500

type TabMessage =
  | { type: 'CLAIM'; tabId: string; jid: string }
  | { type: 'ALIVE'; tabId: string; jid: string }
  | { type: 'TAKEOVER'; tabId: string; jid: string; targetTabId: string }
  | { type: 'RELEASE'; tabId: string; jid: string }

export interface TabCoordinationResult {
  /** Another tab is already connected with the same JID */
  blocked: boolean
  /** This tab was disconnected by another tab taking over */
  takenOver: boolean
  /** Check if connection is free. Returns true if can connect, false if blocked. */
  claimConnection: (jid: string) => Promise<boolean>
  /** Force-claim the connection from the blocking tab */
  takeOver: () => void
  /** Broadcast that this tab released the connection (call on disconnect) */
  releaseConnection: () => void
}

const skipCoordination = isTauri() || typeof BroadcastChannel === 'undefined'

export function useTabCoordination(onTakenOver?: () => void): TabCoordinationResult {
  const [blocked, setBlocked] = useState(false)
  const [takenOver, setTakenOver] = useState(false)

  const channelRef = useRef<BroadcastChannel | null>(null)
  const tabId = useRef(getResource()).current // Stable across reloads via sessionStorage
  const connectedJidRef = useRef<string | null>(null)
  const blockerTabIdRef = useRef<string | null>(null)
  const blockerJidRef = useRef<string | null>(null)
  const onTakenOverRef = useRef(onTakenOver)
  onTakenOverRef.current = onTakenOver

  useEffect(() => {
    // Skip entirely on Tauri or if BroadcastChannel is unavailable
    if (skipCoordination) return

    const channel = new BroadcastChannel(CHANNEL_NAME)
    channelRef.current = channel

    const handleMessage = (event: MessageEvent<TabMessage>) => {
      const msg = event.data
      const myJid = connectedJidRef.current

      switch (msg.type) {
        case 'CLAIM':
          // Another tab wants to connect with this JID — respond if we hold it
          if (msg.jid === myJid && msg.tabId !== tabId) {
            channel.postMessage({
              type: 'ALIVE',
              tabId,
              jid: myJid,
            } satisfies TabMessage)
          }
          break

        case 'ALIVE':
          // Track the blocker for takeOver()
          if (msg.tabId !== tabId) {
            blockerTabIdRef.current = msg.tabId
            blockerJidRef.current = msg.jid
          }
          break

        case 'TAKEOVER':
          // Another tab is forcing us to disconnect
          if (msg.targetTabId === tabId && msg.jid === myJid) {
            connectedJidRef.current = null
            setTakenOver(true)
            channel.postMessage({
              type: 'RELEASE',
              tabId,
              jid: msg.jid,
            } satisfies TabMessage)
            onTakenOverRef.current?.()
          }
          break

        case 'RELEASE':
          if (msg.tabId !== tabId) {
            setBlocked(false)
          }
          break
      }
    }

    channel.addEventListener('message', handleMessage)

    // Broadcast RELEASE when tab is closed
    const handleBeforeUnload = () => {
      const jid = connectedJidRef.current
      if (jid) {
        channel.postMessage({
          type: 'RELEASE',
          tabId,
          jid,
        } satisfies TabMessage)
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      channel.removeEventListener('message', handleMessage)
      channel.close()
      channelRef.current = null
    }
  }, [tabId])

  const claimConnection = useCallback(async (jid: string): Promise<boolean> => {
    const channel = channelRef.current
    if (!channel) return true

    return new Promise<boolean>((resolve) => {
      let resolved = false

      const handleAlive = (event: MessageEvent<TabMessage>) => {
        const msg = event.data
        if (msg.type === 'ALIVE' && msg.jid === jid && msg.tabId !== tabId) {
          resolved = true
          channel.removeEventListener('message', handleAlive)
          blockerTabIdRef.current = msg.tabId
          blockerJidRef.current = msg.jid
          setBlocked(true)
          resolve(false)
        }
      }

      channel.addEventListener('message', handleAlive)

      channel.postMessage({
        type: 'CLAIM',
        tabId,
        jid,
      } satisfies TabMessage)

      setTimeout(() => {
        if (!resolved) {
          channel.removeEventListener('message', handleAlive)
          connectedJidRef.current = jid
          setBlocked(false)
          resolve(true)
        }
      }, CLAIM_TIMEOUT_MS)
    })
  }, [tabId])

  const takeOver = useCallback(() => {
    const channel = channelRef.current
    const jid = blockerJidRef.current
    const targetTabId = blockerTabIdRef.current
    if (!channel || !jid || !targetTabId) return

    channel.postMessage({
      type: 'TAKEOVER',
      tabId,
      jid,
      targetTabId,
    } satisfies TabMessage)

    // Optimistically claim: the target tab will RELEASE, but don't wait for it
    connectedJidRef.current = jid
    blockerTabIdRef.current = null
    blockerJidRef.current = null
    setBlocked(false)
    setTakenOver(false)
  }, [tabId])

  const releaseConnection = useCallback(() => {
    const channel = channelRef.current
    const jid = connectedJidRef.current
    if (!channel || !jid) return

    channel.postMessage({
      type: 'RELEASE',
      tabId,
      jid,
    } satisfies TabMessage)
    connectedJidRef.current = null
  }, [tabId])

  return { blocked, takenOver, claimConnection, takeOver, releaseConnection }
}
