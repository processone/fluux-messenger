import { createContext } from 'react'

// Containment gives each row its own timeline's layout owner; previews and
// virtualized lists opt out here rather than making callers read feature flags.
export const RowLayoutContext = createContext<(() => void) | undefined>(undefined)
