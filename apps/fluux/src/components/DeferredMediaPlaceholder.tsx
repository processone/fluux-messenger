import type { LucideIcon } from 'lucide-react'
import { Download } from 'lucide-react'

interface DeferredMediaPlaceholderProps {
  /** 'box' reserves an aspect-ratio area (image/video); 'card' is a compact row (audio/text). */
  variant: 'box' | 'card'
  icon: LucideIcon
  /** Action label, e.g. "Load image". */
  label: string
  /** Pre-formatted size string, e.g. "1.2 MB". Optional. */
  sizeLabel?: string
  /** Optional file name, shown as a hint of what the media is. */
  name?: string
  /** Box variant only: reserve the loaded media's aspect ratio to avoid layout shift. */
  aspectRatio?: number
  /** Box variant only: max width in px. */
  maxWidthPx?: number
  onLoad: () => void
}

/**
 * Tap-to-load placeholder shown in place of media that is not auto-fetched
 * (public rooms / strangers / "never" policy). Loading nothing remote, it
 * leaks no IP until the user explicitly taps.
 */
export function DeferredMediaPlaceholder({
  variant, icon: Icon, label, name, sizeLabel, aspectRatio, maxWidthPx, onLoad,
}: DeferredMediaPlaceholderProps) {
  if (variant === 'box') {
    return (
      <button
        type="button"
        onClick={onLoad}
        className="mt-2 w-full flex flex-col items-center justify-center gap-2 rounded-lg bg-fluux-hover/60 border border-fluux-border hover:bg-fluux-hover transition-colors text-fluux-muted"
        style={{
          aspectRatio: aspectRatio ?? 4 / 3,
          maxWidth: maxWidthPx ? `${maxWidthPx}px` : '384px',
          maxHeight: '300px',
          minHeight: '100px',
        }}
      >
        <Icon className="size-6" aria-hidden="true" />
        <span className="text-sm font-medium">{label}</span>
        {name && <span className="text-xs max-w-full truncate" title={name}>{name}</span>}
        {sizeLabel && <span className="text-xs">{sizeLabel}</span>}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onLoad}
      className="mt-2 w-full max-w-sm flex items-center gap-3 p-3 rounded-lg bg-fluux-bg/60 border border-fluux-border hover:bg-fluux-hover/60 transition-colors group/file"
    >
      <div className="size-10 rounded-lg bg-fluux-muted/20 text-fluux-muted flex items-center justify-center flex-shrink-0">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-fluux-text truncate">{label}</p>
        {name && <p className="text-xs text-fluux-muted truncate" title={name}>{name}</p>}
        {sizeLabel && <p className="text-xs text-fluux-muted">{sizeLabel}</p>}
      </div>
      <Download className="size-4 text-fluux-muted flex-shrink-0" aria-hidden="true" />
    </button>
  )
}
