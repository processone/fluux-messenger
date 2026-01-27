/**
 * useLinkPreview hook - Detects URLs and fetches link previews
 *
 * Automatically detects URLs in sent messages and fetches OG metadata
 * using the Tauri backend, then sends a fastening with the preview.
 */

import { useCallback, useState } from 'react'
import { useXMPP } from '@fluux/sdk'
import { fetchUrlMetadata, extractFirstUrl, isImageUrl } from '@/utils/linkPreview'
import type { LinkPreview } from '@fluux/sdk'

interface LinkPreviewState {
  isFetching: boolean
  error: string | null
}

export function useLinkPreview() {
  // Get client from context for methods (avoiding useConnection's 12+ subscriptions)
  const { client } = useXMPP()
  const sendLinkPreview = useCallback(
    async (to: string, messageId: string, preview: LinkPreview, type: 'chat' | 'groupchat') => {
      await client.chat.sendLinkPreview(to, messageId, preview, type)
    },
    [client]
  )
  const [state, setState] = useState<LinkPreviewState>({
    isFetching: false,
    error: null,
  })

  /**
   * Process a sent message for link previews.
   * If a URL is found, fetches metadata and sends a fastening.
   *
   * @param messageId - The ID of the sent message
   * @param body - The message body to scan for URLs
   * @param to - The conversation JID
   * @param type - Message type ('chat' or 'groupchat')
   */
  const processMessageForLinkPreview = useCallback(
    async (
      messageId: string,
      body: string,
      to: string,
      type: 'chat' | 'groupchat'
    ): Promise<void> => {
      // Extract first URL from message
      const url = extractFirstUrl(body)
      if (!url) return

      // Skip image URLs - they're displayed inline, not as link previews
      if (isImageUrl(url)) return

      setState({ isFetching: true, error: null })

      try {
        // Fetch URL metadata using Tauri backend
        const metadata = await fetchUrlMetadata(url)
        if (!metadata) {
          setState({ isFetching: false, error: null })
          return
        }

        // Convert to LinkPreview format
        const preview: LinkPreview = {
          url: metadata.url,
          ...(metadata.title && { title: metadata.title }),
          ...(metadata.description && { description: metadata.description }),
          ...(metadata.image && { image: metadata.image }),
          ...(metadata.site_name && { siteName: metadata.site_name }),
        }

        // Send the fastening with link preview
        await sendLinkPreview(to, messageId, preview, type)

        setState({ isFetching: false, error: null })
      } catch (err) {
        console.error('Failed to fetch link preview:', err)
        setState({
          isFetching: false,
          error: err instanceof Error ? err.message : 'Failed to fetch preview',
        })
      }
    },
    [sendLinkPreview]
  )

  return {
    ...state,
    processMessageForLinkPreview,
  }
}
