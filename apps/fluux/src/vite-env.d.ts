/// <reference types="vite/client" />

// Build-time injected constants
declare const __APP_VERSION__: string
declare const __GIT_COMMIT__: string
/** Anomaly instrumentation gate — see src/anomaly/gate.ts for the build matrix. */
declare const __FLUUX_ANOMALY__: boolean

// Environment variables (VITE_* prefix)
interface ImportMetaEnv {
  readonly VITE_SHOW_LOGO?: string
  /** Selects the app-icon treatment: 'plain' glass bubble or 'hollow' outline (default). */
  readonly VITE_FLUUX_ICON_STYLE?: 'plain' | 'hollow' | string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
