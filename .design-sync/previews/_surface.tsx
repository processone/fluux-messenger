// Shared preview scaffolding. Not a component preview — the converter only
// compiles `previews/<ComponentName>.tsx`, so the leading underscore keeps
// this file a plain import.
//
// Fluux is dark-first: `:root` sets `color-scheme: dark` and
// `--fluux-text-normal` is near-white. Preview cards render on a white body,
// so a component dropped straight onto it renders invisible text. The app
// always paints a themed surface behind these components; `Surface` is that
// same frame, built from the design system's own utility vocabulary.

import type { ReactNode } from 'react'

export function Surface({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-fluux-bg text-fluux-text font-sans p-6 rounded-xl ${className}`}>
      {children}
    </div>
  )
}

/** Surface sized for a settings pane, where the settings primitives live. */
export function SettingsSurface({ children }: { children: ReactNode }) {
  return <Surface className="max-w-md">{children}</Surface>
}
