import { createContext } from 'react'

/**
 * Runs a change that makes a row taller (Wrap lines) so that a reader sitting at
 * the live edge stays there once the row has grown, as when a new message arrives.
 * Outside a live list (previews, console, static lists) the change just runs.
 */
export type RunKeepingLiveEdge = (grow: () => void) => void

export const LiveEdgeGrowthContext = createContext<RunKeepingLiveEdge>((grow) => grow())
