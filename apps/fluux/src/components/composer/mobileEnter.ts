import { isMobileWeb } from '@/hooks/useIsMobileWeb'
import { platform } from '@/platform'

export function usesMobileEnterKey(): boolean {
  return platform().shell === 'mobile' || isMobileWeb()
}
