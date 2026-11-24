import { useCallback, useRef, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload } from 'lucide-react'
import { MediaAutoloadProvider } from '@/contexts'
import type { ConversationThreadLayout } from '@/hooks/useConversationThread'
import { ConversationColumn, ConversationTail } from './ConversationColumn'
import { FindOnPageBar } from './FindOnPageBar'
import { ReactionMentions } from './ReactionMentions'
import { EasterEggMentions } from './EasterEggMentions'
import { EasterEggAnimation } from '../easter-eggs/EasterEggAnimation'
import { JumpToDateDialog } from './JumpToDateDialog'
import { focusConversationActions, isDatePillVisible } from './datePillFocus'

interface ConversationThreadProps {
  /** `layout` from useConversationThread. */
  thread: ConversationThreadLayout
  mainContentRef?: RefObject<HTMLElement | null>
  mediaAutoLoad: ComponentProps<typeof MediaAutoloadProvider>['autoLoad']
  /** Classes of the root element, which also takes the drag handlers. */
  rootClassName: string
  /** Hides the whole view from focus and assistive technology while another pane covers it. */
  covered?: boolean
  /** When set, the column and `columnEnd` sit in a wrapper with these classes. */
  columnClassName?: string
  /** Slots a view fills with what is specific to its kind. */
  header: ReactNode
  /** Between the header and the list: banners and dialogs of the conversation. */
  aboveList?: ReactNode
  list: ReactNode
  composer: ReactNode
  /** Beside the column: dialogs the column opens. */
  columnEnd?: ReactNode
  /** Beside the column: a side panel. */
  aside?: ReactNode
  /** Over the view: menus and modals. */
  overlays?: ReactNode
}

/** The layout of a conversation: header, list in its focus zone, mentions and composer. */
export function ConversationThread({
  thread, mainContentRef, mediaAutoLoad, rootClassName, covered, columnClassName,
  header, aboveList, list, composer, columnEnd, aside, overlays,
}: ConversationThreadProps) {
  const { t } = useTranslation()
  const { id, find } = thread
  const rootRef = useRef<HTMLDivElement>(null)
  const restoreDateFocus = useCallback((opener: HTMLElement | null, jumped: boolean) => {
    const root = rootRef.current
    // An old dialog's cleanup must not focus a conversation opened in the meantime.
    if (!root?.isConnected || root.dataset.conversationThread !== id || root.closest('[inert], [aria-hidden="true"]')) return
    if (jumped) root.querySelector<HTMLElement>('[data-date-focus-target]')?.focus({ preventScroll: true })
    else if (opener?.matches('[data-date-pill]') && root.contains(opener) && isDatePillVisible(opener)) opener.focus({ preventScroll: true })
    else focusConversationActions(root)
  }, [id])

  const column = (
    <ConversationColumn>
      {header}
      {aboveList}

      {/* Messages - focusable zone for Tab cycling */}
      <div
        ref={mainContentRef as RefObject<HTMLDivElement>}
        tabIndex={0}
        data-date-focus-target
        // `composer-active` hides the per-message hover toolbars while typing via CSS (index.css),
        // instead of threading `isComposing` into every row's `hideToolbar` prop, which re-rendered
        // (and relayouted) the whole non-virtualized list on each typing burst.
        // pt-px and pb-px leave room only for the 1px inset focus outline, so the list and its
        // fades run from the header's bottom line to the composer card.
        className={`focus-zone flex-1 flex flex-col min-h-0 px-1 pb-px pt-px relative${thread.isComposing ? ' composer-active' : ''}`}
        onKeyDown={thread.onKeyDown}
        onMouseMove={thread.onMouseMove}
        onMouseLeave={thread.onMouseLeave}
      >
        {find.isOpen && (
          <FindOnPageBar
            searchText={find.searchText}
            onSearchTextChange={find.setSearchText}
            currentMatchIndex={find.currentMatchIndex}
            totalMatches={find.matchIds.length}
            onNext={find.goToNext}
            onPrev={find.goToPrev}
            onClose={find.close}
          />
        )}
        <MediaAutoloadProvider autoLoad={mediaAutoLoad}>{list}</MediaAutoloadProvider>
      </div>

      <ConversationTail>
        {/* Mention pills pinned above the composer */}
        {id && <ReactionMentions conversationId={id} onSee={thread.onSeeReaction} />}
        {id && <EasterEggMentions conversationId={id} onReplay={thread.onReplayEasterEgg} />}
        {composer}
      </ConversationTail>
    </ConversationColumn>
  )

  return (
    <div
      ref={rootRef}
      data-conversation-thread={id}
      className={rootClassName}
      inert={covered || undefined}
      aria-hidden={covered || undefined}
      {...thread.dragHandlers}
    >
      {/* Drop zone overlay */}
      {thread.isDragging && (
        <div className="absolute inset-0 z-50 bg-fluux-bg/95 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-fluux-brand rounded-xl bg-fluux-bg/50">
            <Upload className="size-12 text-fluux-brand" />
            <p className="text-lg font-medium text-fluux-text">{t('upload.dropToUpload')}</p>
          </div>
        </div>
      )}

      {columnClassName ? <div className={columnClassName}>{column}{columnEnd}</div> : <>{column}{columnEnd}</>}
      {aside}

      {/* Easter egg animation */}
      {thread.activeAnimation && (
        <EasterEggAnimation animation={thread.activeAnimation.animation} onComplete={thread.clearAnimation} senderName={thread.activeAnimation.senderName} />
      )}
      {thread.jumpToDate && <JumpToDateDialog key={thread.jumpToDate.conversationId} {...thread.jumpToDate} onRestoreFocus={restoreDateFocus} />}
      {overlays}
    </div>
  )
}
