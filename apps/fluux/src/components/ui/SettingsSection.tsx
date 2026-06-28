import type { ReactNode } from 'react'

interface SettingsSectionProps {
  title: string
  description?: string
  children: ReactNode
  className?: string
}

export function SettingsSection({ title, description, children, className = '' }: SettingsSectionProps) {
  return (
    <section className={className}>
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-1">{title}</h3>
      {description && <p className="text-xs text-fluux-muted mb-3">{description}</p>}
      <div className={description ? '' : 'mt-3'}>{children}</div>
    </section>
  )
}
