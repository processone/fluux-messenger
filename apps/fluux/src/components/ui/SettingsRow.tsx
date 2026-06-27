import type { ReactNode } from 'react'

interface SettingsRowProps {
  label: string
  description?: string
  htmlFor?: string
  children?: ReactNode
  className?: string
}

export function SettingsRow({ label, description, htmlFor, children, className = '' }: SettingsRowProps) {
  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-3 ${className}`}>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm text-fluux-text">{label}</label>
        {description && <p className="text-xs text-fluux-muted mt-0.5">{description}</p>}
      </div>
      {children != null && <div className="flex-shrink-0">{children}</div>}
    </div>
  )
}
