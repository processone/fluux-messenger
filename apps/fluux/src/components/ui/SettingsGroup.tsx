import type { ReactNode } from 'react'

export function SettingsGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-[color:var(--fluux-surface-divider)] divide-y divide-[color:var(--fluux-surface-divider)] overflow-hidden ${className}`}>
      {children}
    </div>
  )
}
