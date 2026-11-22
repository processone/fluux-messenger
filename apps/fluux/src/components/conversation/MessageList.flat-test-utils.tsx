/**
 * Test adapter: renders the real `MessageList` from the flat prop names the scroll suites were
 * written against, so one place owns the mapping onto the list boundary
 * (`timeline` / `readMarkers` / `target` / `handleRef`). Nothing here stubs the list — every
 * prop reaches the real component — and the raw scroll element and at-bottom flag are not
 * accepted: suites that need the flag read it through `handleRef`.
 */
import type { ReactNode } from 'react'
import type { BaseMessage, GapInterval, MessageRowRef } from '@fluux/sdk'
import type { CopyMessageMeta } from '@/utils/buildCopyText'
import { MessageList } from './MessageList'
import type { MessageListHandleRef } from './messageListBoundary'

export interface FlatMessageListProps<T extends BaseMessage> {
  messages: T[]
  conversationId: string
  messageIngressVersion?: number
  interiorPlacementVersion?: number
  firstNewMessageRow?: MessageRowRef
  firstNewMessageIsProvisional?: boolean
  firstNewMessageCount?: number
  targetMessageId?: string | MessageRowRef | null
  onTargetMessageConsumed?: () => void
  clearFirstNewMessageId?: () => void
  readPointerRow?: MessageRowRef
  unreadCount?: number
  typingUsers?: string[]
  formatTypingUser?: (user: string) => string
  renderMessage: (message: T, index: number, groupMessages: T[], showNewMarker: boolean, onMediaLoad: () => void) => ReactNode
  extraContent?: ReactNode
  emptyState?: ReactNode
  isLoading?: boolean
  loadingState?: ReactNode
  handleRef?: MessageListHandleRef
  onLiveEdgeMeasured?: (atEdge: boolean) => void
  onScrollToTop?: () => void
  onLoadAround?: (anchorRow: MessageRowRef, signal?: AbortSignal) => Promise<unknown> | void
  isLoadingOlder?: boolean
  onLoadNewer?: () => void
  isLoadingNewer?: boolean
  windowAtLiveEdge?: boolean
  onJumpToLatest?: () => Promise<unknown> | void
  isHistoryComplete?: boolean
  historyUnavailable?: boolean
  onMessageSeen?: (rowId: string) => void
  staticMode?: boolean
  getStaticMessageId?: (message: T) => string
  lastSentMessageId?: string | null
  gaps?: readonly GapInterval[]
  onCatchUpHistory?: (gapStart: number) => void
  isCatchingUp?: boolean
  formatMessageForCopy?: (message: T) => CopyMessageMeta
}

export function FlatMessageList<T extends BaseMessage>(props: FlatMessageListProps<T>) {
  return (
    <MessageList<T>
      conversationId={props.conversationId}
      timeline={{
        messages: props.messages,
        ingressVersion: props.messageIngressVersion,
        interiorPlacementVersion: props.interiorPlacementVersion,
        history: {
          onLoadOlder: props.onScrollToTop,
          isLoadingOlder: props.isLoadingOlder,
          isComplete: props.isHistoryComplete,
          unavailable: props.historyUnavailable,
          onLoadAround: props.onLoadAround,
        },
        window: {
          atLiveEdge: props.windowAtLiveEdge,
          onLoadNewer: props.onLoadNewer,
          isLoadingNewer: props.isLoadingNewer,
          onJumpToLatest: props.onJumpToLatest,
        },
        gaps: { intervals: props.gaps, onCatchUp: props.onCatchUpHistory, isCatchingUp: props.isCatchingUp },
      }}
      readMarkers={{
        firstNewRow: props.firstNewMessageRow,
        firstNewIsProvisional: props.firstNewMessageIsProvisional,
        firstNewCount: props.firstNewMessageCount,
        readPointerRow: props.readPointerRow,
        unreadCount: props.unreadCount,
        onSeen: props.onMessageSeen,
        onClear: props.clearFirstNewMessageId,
        onLiveEdgeMeasured: props.onLiveEdgeMeasured,
      }}
      target={{ id: props.targetMessageId, onConsumed: props.onTargetMessageConsumed }}
      handleRef={props.handleRef}
      renderMessage={props.renderMessage}
      formatMessageForCopy={props.formatMessageForCopy}
      typing={{ users: props.typingUsers ?? [], format: props.formatTypingUser }}
      lastSentMessageId={props.lastSentMessageId}
      loading={props.isLoading && props.loadingState ? props.loadingState : undefined}
      emptyState={props.emptyState}
      extraContent={props.extraContent}
      staticRows={props.staticMode ? { getId: props.getStaticMessageId } : undefined}
    />
  )
}
