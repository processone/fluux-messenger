import { useState } from 'react'
import { useMediaAutoload } from '@/contexts'
import { approveMediaUrl, isMediaUrlApproved } from '@/utils/mediaAutoload'

/**
 * Gates a single remote-media fetch behind the conversation's media-autoload
 * policy. Returns whether the media should load now (the policy auto-loads, or
 * the user already tapped this URL this session) plus an `approve` callback to
 * call when the user taps to load.
 */
export function useDeferredMedia(sourceUrl: string): { shouldLoad: boolean; approve: () => void } {
  const autoLoad = useMediaAutoload()
  const [approved, setApproved] = useState(() => isMediaUrlApproved(sourceUrl))
  const shouldLoad = autoLoad || approved
  const approve = () => {
    approveMediaUrl(sourceUrl)
    setApproved(true)
  }
  return { shouldLoad, approve }
}
