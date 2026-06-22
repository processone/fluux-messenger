import { useState } from 'react'
import { useMediaAutoload } from '@/contexts'
import { approveMediaUrl, isMediaUrlApproved } from '@/utils/mediaAutoload'

/**
 * Gates a single remote-media fetch behind the conversation's media-autoload
 * policy. Returns whether the media should load now (the policy auto-loads, the
 * user already tapped this URL this session, or the message is the local user's
 * own) plus an `approve` callback to call when the user taps to load.
 *
 * `isOwnMessage` short-circuits the deferral: content the local user authored
 * carries no IP-leak or safety cost, so it always loads regardless of policy.
 */
export function useDeferredMedia(
  sourceUrl: string,
  isOwnMessage = false,
): { shouldLoad: boolean; approve: () => void } {
  const autoLoad = useMediaAutoload()
  const [approved, setApproved] = useState(() => isMediaUrlApproved(sourceUrl))
  const shouldLoad = autoLoad || approved || isOwnMessage
  const approve = () => {
    approveMediaUrl(sourceUrl)
    setApproved(true)
  }
  return { shouldLoad, approve }
}
