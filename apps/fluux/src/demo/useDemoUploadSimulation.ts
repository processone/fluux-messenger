/**
 * Hook that simulates file upload progress in demo mode.
 *
 * Listens for `demo:custom` events with `type: 'upload-start'` and drives
 * a fake progress bar. When complete, emits an outgoing message with the
 * file attachment.
 *
 * This is a no-op when not rendered (only used inside DemoTutorialProvider).
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import type { DemoClient } from '@fluux/sdk'

export interface DemoUploadState {
  isUploading: boolean
  progress: number
  fileName: string
  conversationId: string | null
}

const INITIAL_STATE: DemoUploadState = {
  isUploading: false,
  progress: 0,
  fileName: '',
  conversationId: null,
}

export function useDemoUploadSimulation(client: DemoClient) {
  const [uploadState, setUploadState] = useState<DemoUploadState>(INITIAL_STATE)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const clientRef = useRef(client)
  clientRef.current = client

  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  useEffect(() => {
    const handler = (payload: { type: string; [key: string]: unknown }) => {
      if (payload.type !== 'upload-start') return

      const conversationId = payload.conversationId as string
      const file = payload.file as { name: string; size: number; mediaType: string }
      if (!conversationId || !file) return

      // Start fake upload
      setUploadState({
        isUploading: true,
        progress: 0,
        fileName: file.name,
        conversationId,
      })

      let progress = 0
      intervalRef.current = setInterval(() => {
        progress += 12 + Math.random() * 8 // 12-20% per tick
        if (progress >= 100) {
          progress = 100
          cleanup()

          // Emit the final outgoing message with attachment
          clientRef.current.emitSDK('chat:message', {
            message: {
              type: 'chat' as const,
              id: `demo-upload-${Date.now()}`,
              from: 'you@fluux.chat',
              body: `Shared ${file.name}`,
              timestamp: new Date(),
              isOutgoing: true,
              conversationId,
              attachment: {
                url: `./demo/screenshot-fluux-contacts.png`, // reuse existing asset
                name: file.name,
                mediaType: file.mediaType,
                size: file.size,
                width: file.mediaType.startsWith('image/') ? 1456 : undefined,
                height: file.mediaType.startsWith('image/') ? 816 : undefined,
              },
            },
          })

          setUploadState(INITIAL_STATE)
        } else {
          setUploadState(prev => ({ ...prev, progress }))
        }
      }, 800)
    }

    const unsubscribe = client.subscribe('demo:custom', handler)
    return () => {
      unsubscribe()
      cleanup()
    }
  }, [client, cleanup])

  return uploadState
}
