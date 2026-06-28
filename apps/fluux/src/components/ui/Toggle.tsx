interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /**
   * Async-pending affordance: while true the toggle reads as "busy" rather
   * than "blocked" — it renders `cursor-wait` (taking precedence over the
   * `disabled` `cursor-not-allowed`) and ignores clicks. Mirrors the
   * isToggling state the inline EncryptionSettings toggle used to show.
   */
  loading?: boolean
  id?: string
  'aria-label'?: string
}

export function Toggle({ checked, onChange, disabled = false, loading = false, id, 'aria-label': ariaLabel }: ToggleProps) {
  // `loading` implies non-interactive too: never fire onChange mid-operation.
  const inactive = disabled || loading
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={inactive}
      onClick={() => !inactive && onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
        checked ? 'bg-fluux-brand' : 'bg-fluux-hover'
      } ${inactive ? 'opacity-50' : ''} ${
        loading ? 'cursor-wait' : inactive ? 'cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      <span
        className={`absolute top-0.5 start-0.5 size-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  )
}
