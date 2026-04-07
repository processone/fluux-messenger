import React from 'react'
import { Tooltip } from '../Tooltip'

interface IconRailButtonProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  active: boolean
  onClick: () => void
  disabled?: boolean
  showBadge?: boolean
}

export function IconRailButton({
  icon: Icon,
  label,
  active,
  onClick,
  disabled,
  showBadge
}: IconRailButtonProps) {
  return (
    <Tooltip content={label} position="right" delay={500}>
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={`relative w-10 h-10 rounded-xl flex items-center justify-center transition-colors
          focus-visible:ring-2 focus-visible:ring-fluux-brand focus-visible:ring-offset-2 focus-visible:ring-offset-fluux-sidebar
          ${active
            ? 'bg-fluux-brand text-fluux-text-on-accent'
            : disabled
              ? 'text-fluux-muted/50 cursor-not-allowed'
              : 'text-fluux-muted hover:bg-white/10 hover:text-fluux-text'
          }`}
      >
        <Icon className="w-5 h-5" />
        {showBadge && (
          <span className="absolute top-0 end-0 w-3 h-3 bg-fluux-red rounded-full border-2 border-fluux-sidebar" />
        )}
      </button>
    </Tooltip>
  )
}
