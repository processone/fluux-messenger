import { ChevronRight } from 'lucide-react'

interface Crumb {
  label: string
  onClick?: () => void
}

interface AdminBreadcrumbProps {
  crumbs: Crumb[]
}

export function AdminBreadcrumb({ crumbs }: AdminBreadcrumbProps) {
  return (
    <nav className="flex items-center gap-1 min-w-0" aria-label="breadcrumb">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1
        return (
          <span key={index} className="flex items-center gap-1 min-w-0">
            {index > 0 && (
              <ChevronRight className="size-3.5 text-fluux-muted shrink-0" />
            )}
            {!isLast && crumb.onClick ? (
              <button
                onClick={crumb.onClick}
                className={`text-sm text-fluux-muted hover:text-fluux-text transition-colors ${
                  index === 0 ? 'shrink-0 whitespace-nowrap' : 'truncate max-w-[120px]'
                }`}
              >
                {crumb.label}
              </button>
            ) : (
              <span
                className={`text-sm truncate ${isLast ? 'text-fluux-text font-semibold' : 'text-fluux-muted'}`}
                aria-current={isLast ? 'page' : undefined}
              >
                {crumb.label}
              </span>
            )}
          </span>
        )
      })}
    </nav>
  )
}
