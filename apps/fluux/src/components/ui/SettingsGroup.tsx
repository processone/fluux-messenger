import type { ReactNode } from 'react'

export function SettingsGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`fluux-card divide-y divide-[color:var(--fluux-surface-divider)] overflow-hidden ${className}`}>
      {children}
    </div>
  )
}
