import { ChevronDown } from 'lucide-react'
import type { SelectHTMLAttributes, ReactNode } from 'react'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode
}

export function Select({ children, className = '', ...props }: SelectProps) {
  return (
    <div className="relative">
      <select
        {...props}
        className={`w-full appearance-none px-4 py-3 pe-10 rounded-lg border-2 border-fluux-hover bg-fluux-bg text-fluux-text cursor-pointer hover:border-fluux-muted focus:border-fluux-brand focus:outline-none transition-colors ${className}`}
      >
        {children}
      </select>
      <ChevronDown className="absolute end-3 top-1/2 -translate-y-1/2 size-5 text-fluux-muted pointer-events-none" />
    </div>
  )
}
