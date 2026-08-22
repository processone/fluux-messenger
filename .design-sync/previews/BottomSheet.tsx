// BottomSheet portals a fixed, full-viewport overlay to document.body, so it
// cannot be framed by a Surface the way the inline components are — it paints
// its own scrim and glass panel over the whole card. cfg.overrides pins the
// card to a single phone-sized viewport so the open state renders inside it.
import { BottomSheet } from '@xmpp/fluux'
import { Reply, Copy, Forward, Trash2 } from 'lucide-react'

const noop = () => {}

const action = 'w-full flex items-center gap-3 px-4 py-3 text-start text-sm hover:bg-fluux-hover transition-colors'

export const MessageActions = () => (
  <BottomSheet open onClose={noop} title="Message actions">
    <button type="button" className={`${action} text-fluux-text`}>
      <Reply className="size-4" /> Reply
    </button>
    <button type="button" className={`${action} text-fluux-text`}>
      <Copy className="size-4" /> Copy text
    </button>
    <button type="button" className={`${action} text-fluux-text`}>
      <Forward className="size-4" /> Forward
    </button>
    <button type="button" className={`${action} text-fluux-error`}>
      <Trash2 className="size-4" /> Delete
    </button>
  </BottomSheet>
)
