import { Download, Share } from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import { platform } from '@/platform'

/** Translation key naming the save action: sharing where files leave through the share sheet. */
export function saveActionLabelKey(): 'common.share' | 'common.download' {
  return platform().savesThroughShareSheet ? 'common.share' : 'common.download'
}

/** Icon for the save action, matching {@link saveActionLabelKey}. */
export function SaveActionIcon(props: LucideProps) {
  return platform().savesThroughShareSheet ? <Share {...props} /> : <Download {...props} />
}
