import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useClickOutside } from '@/hooks'
import { Tooltip } from './Tooltip'

interface EmojiPickerProps {
  onSelect: (emoji: string) => void
  onClose: () => void
}

// Category icons (using emojis as icons)
const CATEGORY_ICONS: Record<string, string> = {
  smileys: '😀',
  people: '👋',
  animals: '🐶',
  food: '🍎',
  activities: '⚽',
  travel: '🚗',
  objects: '💡',
  symbols: '❤️',
}

// Comprehensive emoji data by category
const EMOJI_CATEGORIES: Record<string, string[]> = {
  smileys: [
    '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😊',
    '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋',
    '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐',
    '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌',
    '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧',
    '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓',
    '🧐', '😕', '😟', '🙁', '😮', '😯', '😲', '😳', '🥺', '😦',
    '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞',
    '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿',
  ],
  people: [
    '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞',
    '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '👍', '👎',
    '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏',
    '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻',
    '👃', '🧠', '👀', '👁️', '👅', '👄', '👶', '🧒', '👦', '👧',
    '🧑', '👱', '👨', '🧔', '👩', '🧓', '👴', '👵', '🙍', '🙎',
    '🙅', '🙆', '💁', '🙋', '🧏', '🙇', '🤦', '🤷', '👮', '🕵️',
    '💂', '🥷', '👷', '🤴', '👸', '👳', '👲', '🧕', '🤵', '👰',
  ],
  animals: [
    '🐶', '🐕', '🦮', '🐩', '🐺', '🦊', '🦝', '🐱', '🐈', '🦁',
    '🐯', '🐅', '🐆', '🐴', '🐎', '🦄', '🦓', '🦌', '🦬', '🐮',
    '🐂', '🐃', '🐄', '🐷', '🐖', '🐗', '🐽', '🐏', '🐑', '🐐',
    '🐪', '🐫', '🦙', '🦒', '🐘', '🦣', '🦏', '🦛', '🐭', '🐁',
    '🐀', '🐹', '🐰', '🐇', '🐿️', '🦫', '🦔', '🦇', '🐻', '🐨',
    '🐼', '🦥', '🦦', '🦨', '🦘', '🦡', '🐾', '🦃', '🐔', '🐓',
    '🐣', '🐤', '🐥', '🐦', '🐧', '🕊️', '🦅', '🦆', '🦢', '🦉',
    '🦤', '🪶', '🦩', '🦚', '🦜', '🐸', '🐊', '🐢', '🦎', '🐍',
  ],
  food: [
    '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈',
    '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦',
    '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔',
    '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈',
    '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🌭', '🍔', '🍟', '🍕',
    '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕',
    '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤',
    '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨',
    '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿',
  ],
  activities: [
    '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱',
    '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳',
    '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷',
    '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '⛹️',
    '🤺', '🤾', '🏌️', '🏇', '⛑️', '🎮', '🕹️', '🎲', '🧩', '♟️',
    '🎰', '🎳', '🎯', '🎭', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹',
    '🥁', '🪘', '🎷', '🎺', '🪗', '🎸', '🪕', '🎻', '🎪', '🎟️',
  ],
  travel: [
    '🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐',
    '🛻', '🚚', '🚛', '🚜', '🏍️', '🛵', '🚲', '🛴', '🛺', '🚨',
    '🚔', '🚍', '🚘', '🚖', '🚡', '🚠', '🚟', '🚃', '🚋', '🚞',
    '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇', '🚊', '🚉', '✈️',
    '🛫', '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸', '🚁', '🛶', '⛵',
    '🚤', '🛥️', '🛳️', '⛴️', '🚢', '⚓', '🪝', '⛽', '🚧', '🚦',
    '🚥', '🗺️', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟️', '🎡', '🎢',
    '🎠', '⛲', '⛱️', '🏖️', '🏝️', '🏜️', '🌋', '⛰️', '🏔️', '🗻',
    '🏕️', '🛖', '🏠', '🏡', '🏘️', '🏚️', '🏗️', '🏢', '🏬', '🏣',
  ],
  objects: [
    '⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '💽',
    '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥', '📽️', '🎞️',
    '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️', '🎛️', '🧭',
    '⏱️', '⏲️', '⏰', '🕰️', '⌛', '⏳', '📡', '🔋', '🔌', '💡',
    '🔦', '🕯️', '🪔', '🧯', '🛢️', '💸', '💵', '💴', '💶', '💷',
    '🪙', '💰', '💳', '💎', '⚖️', '🪜', '🧰', '🪛', '🔧', '🔨',
    '⚒️', '🛠️', '⛏️', '🪚', '🔩', '⚙️', '🪤', '🧱', '⛓️', '🧲',
    '🔫', '💣', '🧨', '🪓', '🔪', '🗡️', '⚔️', '🛡️', '🚬', '⚰️',
  ],
  symbols: [
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
    '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️',
    '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐',
    '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐',
    '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳',
    '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️',
    '㊗️', '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️',
    '🆘', '❌', '⭕', '🛑', '⛔', '📛', '🚫', '💯', '💢', '♨️',
    '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗', '❕', '❓',
    '❔', '‼️', '⁉️', '🔅', '🔆', '⚜️', '🔱', '✨', '⭐', '🌟',
  ],
}

type CategoryKey = keyof typeof EMOJI_CATEGORIES

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const { t } = useTranslation()
  const [activeCategory, setActiveCategory] = useState<CategoryKey>('smileys')
  const pickerRef = useRef<HTMLDivElement>(null)

  // Close picker when clicking outside
  const handleClose = useCallback(() => onClose(), [onClose])
  useClickOutside(pickerRef, handleClose, true)

  const handleEmojiClick = (emoji: string) => {
    onSelect(emoji)
  }

  const categories = Object.keys(EMOJI_CATEGORIES) as CategoryKey[]

  return (
    <div
      ref={pickerRef}
      className="w-80 bg-fluux-bg border border-fluux-hover rounded-lg shadow-xl overflow-hidden"
    >
      {/* Category tabs */}
      <div className="flex border-b border-fluux-hover bg-fluux-sidebar">
        {categories.map((category) => (
          <Tooltip key={category} content={t(`emoji.categories.${category}`)}>
            <button
              type="button"
              onClick={() => setActiveCategory(category)}
              className={`flex-1 p-2 text-lg transition-colors hover:bg-fluux-hover
                         ${activeCategory === category ? 'bg-fluux-hover border-b-2 border-fluux-brand' : ''}`}
            >
              {CATEGORY_ICONS[category]}
            </button>
          </Tooltip>
        ))}
      </div>

      {/* Emoji grid */}
      <div className="h-64 overflow-y-auto p-2">
        <div className="grid grid-cols-8 gap-1">
          {EMOJI_CATEGORIES[activeCategory].map((emoji, index) => (
            <button
              type="button"
              key={`${emoji}-${index}`}
              onClick={() => handleEmojiClick(emoji)}
              className="p-1.5 text-xl rounded hover:bg-fluux-hover transition-colors"
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
