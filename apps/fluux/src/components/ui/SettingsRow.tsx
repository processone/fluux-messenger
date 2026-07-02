import type { ReactNode } from 'react'

interface SettingsRowProps {
  label: string
  description?: string
  htmlFor?: string
  /**
   * When provided, the whole row becomes a full-width clickable button so the
   * entire surface is the click/touch target. Use ONLY for action rows whose
   * `children` are non-interactive decoration — a button-in-button is invalid
   * HTML, so do NOT combine `onClick` with an interactive child (Toggle/Select).
   */
  onClick?: () => void
  /** Renders the label in the destructive (red) color. Caller is responsible for tinting any icon passed as `children` to match. */
  danger?: boolean
  /** Disables the row: renders a real disabled `<button>` (native `disabled` attribute), dimmed and unclickable. Only meaningful together with `onClick`. */
  disabled?: boolean
  children?: ReactNode
  className?: string
}

export function SettingsRow({
  label,
  description,
  htmlFor,
  onClick,
  danger = false,
  disabled = false,
  children,
  className = '',
}: SettingsRowProps) {
  const inner = (
    <>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className={`block text-sm ${danger ? 'text-fluux-error' : 'text-fluux-text'}`}>
          {label}
        </label>
        {description && <p className="text-xs text-fluux-muted mt-0.5">{description}</p>}
      </div>
      {children != null && <div className="flex-shrink-0">{children}</div>}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`w-full text-start flex items-center justify-between gap-4 px-4 py-3 hover:bg-fluux-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent ${className}`}
      >
        {inner}
      </button>
    )
  }

  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-3 ${className}`}>
      {inner}
    </div>
  )
}
