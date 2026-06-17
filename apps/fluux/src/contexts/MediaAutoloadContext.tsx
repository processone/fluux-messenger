import { createContext, useContext, type ReactNode } from 'react'

/**
 * Whether media (images, video, audio, text previews, link-preview images)
 * should auto-fetch on render in the current conversation subtree.
 *
 * Defaults to `true` (today's behaviour) when no provider is present, so
 * components rendered outside a conversation view (e.g. SearchContextView,
 * unit tests) keep auto-loading. RoomView/ChatView wrap their message list
 * with a computed value.
 */
const MediaAutoloadContext = createContext<boolean>(true)

export function MediaAutoloadProvider({ autoLoad, children }: { autoLoad: boolean; children: ReactNode }) {
  return <MediaAutoloadContext.Provider value={autoLoad}>{children}</MediaAutoloadContext.Provider>
}

export function useMediaAutoload(): boolean {
  return useContext(MediaAutoloadContext)
}
