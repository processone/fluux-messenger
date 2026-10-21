import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface SettingsDisclosureProps {
  title: string
  children: ReactNode
  /** Keep ongoing work and its progress visible until it completes. */
  stayOpen?: boolean
}

export function SettingsDisclosure({ title, children, stayOpen = false }: SettingsDisclosureProps) {
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()
  const visible = expanded || stayOpen

  return (
    <section className="rounded-lg border border-fluux-border bg-fluux-bg/40 overflow-hidden">
      <h3>
        <button
          type="button"
          aria-expanded={visible}
          aria-controls={panelId}
          disabled={stayOpen}
          onClick={() => setExpanded(!visible)}
          className="flex w-full items-center gap-2 px-4 py-3 text-start text-sm font-medium text-fluux-text
                     hover:bg-fluux-hover transition-colors focus-visible:outline-none focus-visible:ring-2
                     focus-visible:ring-inset focus-visible:ring-fluux-brand disabled:cursor-default"
        >
          {visible
            ? <ChevronDown className="size-4 shrink-0 text-fluux-muted" />
            : <ChevronRight className="size-4 shrink-0 text-fluux-muted rtl-mirror" />}
          {title}
        </button>
      </h3>
      <div id={panelId} hidden={!visible} className="px-4 pb-4 pt-1 space-y-4">
        {children}
      </div>
    </section>
  )
}
