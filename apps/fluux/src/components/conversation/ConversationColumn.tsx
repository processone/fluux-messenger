import type { ReactNode } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'

/** Keeps the scroller and its chrome at the same width so width observers see text rewrap. */
export function ConversationColumn({ children }: { children: ReactNode }) {
  const enabled = useSettingsStore((s) => s.readingWidthEnabled)
  const width = useSettingsStore((s) => s.readingWidth)
  return (
    <div
      data-conversation-column
      className="flex flex-col flex-1 min-h-0 min-w-0 w-full mx-auto"
      style={{ maxWidth: enabled ? width : undefined }}
    >
      {children}
    </div>
  )
}
