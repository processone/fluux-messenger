import type { LucideIcon } from 'lucide-react'

interface InfoRowProps {
  icon: LucideIcon
  label: string
}

export function InfoRow({ icon: Icon, label }: InfoRowProps) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <Icon className="w-4 h-4 text-fluux-muted flex-shrink-0" aria-hidden />
      <span className="text-sm text-fluux-text break-words">{label}</span>
    </div>
  )
}
