import React, { useState, useRef, useEffect, useCallback, Suspense, lazy, type ReactNode, type RefObject, type Ref, useImperativeHandle } from 'react'
import { useTranslation } from 'react-i18next'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { Send, Smile, Paperclip, Reply, X, Pencil, Loader2, Image, FileText, Trash2, BarChart3, Plus } from 'lucide-react'
import { useClickOutside, useSlashCommands } from '@/hooks'
import { Tooltip } from './Tooltip'
import { TextArea } from './ui/TextInput'

// Lazy-load emoji picker — keeps ~150KB of emoji data out of the main bundle
const emojiPickerImport = () => import('./EmojiPicker').then(m => ({ default: m.EmojiPicker }))
const EmojiPicker = lazy(emojiPickerImport)
import type { FileAttachment } from '@fluux/sdk'

// Format file size for display
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// Typing notification constants (XEP-0085)
const COMPOSING_THROTTLE_MS = 2000
// When user stops typing, wait this long before sending "paused" state.
// Note: When switching conversations, we intentionally rely on this timeout
// rather than immediately sending "paused" to the previous conversation.
// This reduces network traffic and is acceptable UX since the remote user
// will see the typing indicator disappear within a few seconds.
const PAUSED_TIMEOUT_MS = 5000
const COMPOSING_UI_TIMEOUT_MS = 1500

// Base textarea classes - exported for custom renderInput implementations to reuse
export const MESSAGE_INPUT_BASE_CLASSES = 'message-input flex-1 px-2 py-3 bg-transparent resize-none overflow-y-auto'
export const MESSAGE_INPUT_TEXT_CLASSES = 'text-fluux-text placeholder:text-fluux-muted'
// For overlay-based inputs (e.g., mention highlighting) - text is transparent, caret visible via style
export const MESSAGE_INPUT_OVERLAY_CLASSES = 'text-transparent placeholder:text-fluux-muted'

export interface ReplyInfo {
  id: string
  senderName: string
  body: string
  // Full data for constructing reply
  from: string
}

export interface EditInfo {
  id: string
  body: string
  attachment?: FileAttachment
}

export interface MessageComposerHandle {
  focus: () => void
  getText: () => string
  setText: (text: string) => void
}

interface UploadState {
  isUploading: boolean
  progress: number
}

/** Pending attachment staged for sending (not yet sent) */
export interface PendingAttachment {
  file: File
  previewUrl?: string
  // Note: attachment field is NOT included here - files are only uploaded when user clicks Send
  // This prevents accidental file uploads from drag-and-drop mistakes (privacy protection)
}

interface MessageComposerProps {
  /** Ref for the textarea element (for focus zones) */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  /** Placeholder text for the input */
  placeholder: string
  /** Reply info if replying to a message */
  replyingTo?: ReplyInfo | null
  /** Callback when reply is cancelled */
  onCancelReply?: () => void
  /** Edit info if editing a message */
  editingMessage?: EditInfo | null
  /** Callback when edit is cancelled */
  onCancelEdit?: () => void
  /** Callback to send the correction (edit) - attachment is undefined if removed */
  onSendCorrection?: (messageId: string, newBody: string, attachment?: FileAttachment) => Promise<boolean>
  /** Callback to retract (delete) the message being edited when all content is removed */
  onRetractMessage?: (messageId: string) => Promise<void>
  /** Callback when input height changes */
  onInputResize?: () => void
  /** Callback when composing state changes (for hiding toolbars) */
  onComposingChange?: (isComposing: boolean) => void
  /** Send message callback - returns true if handled */
  onSend: (text: string) => Promise<boolean>
  /** Send easter egg animation */
  onSendEasterEgg?: (animation: string) => void
  /** Callback to open poll creator — when set, shows a poll button in the toolbar */
  onCreatePoll?: () => void
  /** Send typing notification */
  onSendTypingState?: (state: 'composing' | 'paused') => void
  /** Whether typing notifications are enabled (e.g., disabled for large rooms) */
  typingNotificationsEnabled?: boolean
  /** Custom input renderer for mention overlay support */
  renderInput?: (props: {
    inputRef: RefObject<HTMLTextAreaElement | null>
    mergedRef: (node: HTMLTextAreaElement | null) => void
    value: string
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
    onSelect?: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void
    onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
    placeholder: string
  }) => ReactNode
  /** Content to render above the input (e.g., mention autocomplete dropdown) */
  aboveInput?: ReactNode
  /** Text value (controlled) - if provided, component is controlled */
  value?: string
  /** Text change handler (for controlled mode) */
  onValueChange?: (value: string) => void
  /** Selection/cursor change handler */
  onSelectionChange?: (position: number) => void
  /** File upload handler */
  onFileSelect?: (file: File) => void
  /** Current upload state */
  uploadState?: UploadState
  /** Whether file upload is supported */
  isUploadSupported?: boolean
  /** Pending attachment staged for sending */
  pendingAttachment?: PendingAttachment | null
  /** Callback to remove pending attachment */
  onRemovePendingAttachment?: () => void
  /** Whether sending is disabled (e.g., when offline) */
  disabled?: boolean
  /** Callback when Up arrow is pressed in empty field (to edit last message) */
  onEditLastMessage?: () => void
}

export function MessageComposer({
  textareaRef,
  placeholder,
  replyingTo,
  onCancelReply,
  editingMessage,
  onCancelEdit,
  onSendCorrection,
  onRetractMessage,
  onInputResize,
  onComposingChange,
  onSend,
  onSendEasterEgg,
  onCreatePoll,
  onSendTypingState,
  typingNotificationsEnabled = true,
  renderInput,
  aboveInput,
  value: controlledValue,
  onValueChange,
  onSelectionChange,
  onFileSelect,
  uploadState,
  isUploadSupported = false,
  pendingAttachment,
  onRemovePendingAttachment,
  disabled = false,
  onEditLastMessage,
  ref,
}: MessageComposerProps & { ref?: Ref<MessageComposerHandle> }) {
  detectRenderLoop('MessageComposer')
  const { t } = useTranslation()
  // Internal state for uncontrolled mode
  const [internalText, setInternalText] = useState('')
  const text = controlledValue !== undefined ? controlledValue : internalText
  const setTextRef = useRef((_t: string) => {})
  setTextRef.current = (t: string) => {
    if (controlledValue !== undefined) {
      onValueChange?.(t)
    } else {
      setInternalText(t)
    }
  }
  const setText = useCallback((t: string) => {
    setTextRef.current(t)
  }, [])

  const [sending, setSending] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [editAttachmentRemoved, setEditAttachmentRemoved] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Merged ref callback to assign to both internal and external refs
  const mergedInputRef = (node: HTMLTextAreaElement | null) => {
    // Assign to internal ref
    (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node
    // Assign to external ref if provided
    if (textareaRef) {
      (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node
    }
  }

  // Compute if current edit state would result in message deletion
  const willDeleteMessage = (() => {
    if (!editingMessage) return false
    const hasText = text.trim().length > 0
    const hasAttachment = editingMessage.attachment && !editAttachmentRemoved
    return !hasText && !hasAttachment
  })()
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const attachMenuRef = useRef<HTMLDivElement>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Typing notification refs
  const lastComposingSentRef = useRef(0)
  const pausedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track which message we've already populated for editing
  const lastEditedMessageIdRef = useRef<string | null>(null)

  // Expose imperative handle
  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    getText: () => text,
    setText: (t: string) => setText(t),
  }), [text, setText])

  // Close menus when clicking outside
  const closeAttachMenu = () => setShowAttachMenu(false)
  useClickOutside(attachMenuRef, closeAttachMenu, showAttachMenu)
  const closeEmojiPicker = () => setShowEmojiPicker(false)
  useClickOutside(emojiPickerRef, closeEmojiPicker, showEmojiPicker)

  // Slash command handler
  const { handleCommand } = useSlashCommands({
    sendEasterEgg: async (animation: string) => {
      if (onSendEasterEgg) onSendEasterEgg(animation)
    },
  })

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (pausedTimeoutRef.current) {
        clearTimeout(pausedTimeoutRef.current)
      }
      if (composingTimeoutRef.current) {
        clearTimeout(composingTimeoutRef.current)
      }
    }
  }, [])

  // Populate input when editing starts (only when a NEW message is being edited)
  useEffect(() => {
    if (editingMessage && editingMessage.id !== lastEditedMessageIdRef.current) {
      lastEditedMessageIdRef.current = editingMessage.id
      setText(editingMessage.body)
      setEditAttachmentRemoved(false) // Reset attachment removal state
      // Focus and move cursor to end
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus()
          const len = editingMessage.body.length
          inputRef.current.setSelectionRange(len, len)
        }
      }, 0)
    } else if (!editingMessage) {
      // Reset when editing is cancelled
      lastEditedMessageIdRef.current = null
      setEditAttachmentRemoved(false)
    }
  }, [editingMessage, setText])

  // Auto-resize textarea based on content (1-8 lines)
  useEffect(() => {
    const textarea = inputRef.current
    if (!textarea) return

    // Save scroll position before resizing
    const savedScrollTop = textarea.scrollTop

    textarea.style.height = 'auto'
    // This value must match the CSS line-height in .message-input (index.css)
    const lineHeight = 24
    const minHeight = lineHeight
    const maxHeight = lineHeight * 8
    const scrollHeight = textarea.scrollHeight
    const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight)
    textarea.style.height = `${newHeight}px`

    // Restore scroll position after height change
    // The browser will naturally keep the cursor visible during typing,
    // but resizing can reset scroll. Only restore if we're at max height.
    if (scrollHeight > maxHeight) {
      textarea.scrollTop = savedScrollTop
    }

    onInputResize?.()
  }, [text, onInputResize])

  // Control character filtering (Tauri macOS arrow-key bug) is handled by
  // the TextArea component — see ui/TextInput.tsx
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)

    // Update toolbar visibility based on typing activity
    onComposingChange?.(true)
    if (composingTimeoutRef.current) {
      clearTimeout(composingTimeoutRef.current)
    }
    composingTimeoutRef.current = setTimeout(() => {
      onComposingChange?.(false)
    }, COMPOSING_UI_TIMEOUT_MS)

    // Typing notifications
    if (!typingNotificationsEnabled || !onSendTypingState) return

    // Clear any pending paused timeout
    if (pausedTimeoutRef.current) {
      clearTimeout(pausedTimeoutRef.current)
      pausedTimeoutRef.current = null
    }

    // Don't send composing for empty text
    if (!e.target.value.trim()) {
      if (lastComposingSentRef.current > 0) {
        onSendTypingState('paused')
        lastComposingSentRef.current = 0
      }
      return
    }

    const now = Date.now()
    // Throttle composing notifications
    if (now - lastComposingSentRef.current > COMPOSING_THROTTLE_MS) {
      onSendTypingState('composing')
      lastComposingSentRef.current = now
    }

    // Set timeout to send paused after inactivity
    pausedTimeoutRef.current = setTimeout(() => {
      if (lastComposingSentRef.current > 0) {
        onSendTypingState('paused')
        lastComposingSentRef.current = 0
      }
    }, PAUSED_TIMEOUT_MS)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const trimmed = text.trim()

    // Check if we're editing and the result would be empty (no text, no attachment)
    const attachmentToKeep = editAttachmentRemoved ? undefined : editingMessage?.attachment
    const isEmptyEdit = editingMessage && !trimmed && !attachmentToKeep
    const hasAttachmentOnly = editingMessage && !trimmed && attachmentToKeep

    // For normal messages, require text OR pending attachment. For edits, allow empty to trigger retraction or attachment-only.
    if (!trimmed && !isEmptyEdit && !hasAttachmentOnly && !pendingAttachment) return
    if (sending) return

    // Handle slash commands (but not when editing)
    if (!editingMessage && trimmed && await handleCommand(trimmed)) {
      setText('')
      inputRef.current?.focus()
      return
    }

    // Clear paused timeout
    if (pausedTimeoutRef.current) {
      clearTimeout(pausedTimeoutRef.current)
      pausedTimeoutRef.current = null
    }
    lastComposingSentRef.current = 0

    setSending(true)
    try {
      let handled: boolean

      if (editingMessage && isEmptyEdit && onRetractMessage) {
        // Edit resulted in empty message - retract it instead
        await onRetractMessage(editingMessage.id)
        setText('')
        onCancelEdit?.()
        inputRef.current?.focus()
      } else if (editingMessage && onSendCorrection) {
        // Handle edit mode - send correction
        // Pass attachment if it exists and wasn't removed, otherwise undefined to remove it
        handled = await onSendCorrection(editingMessage.id, trimmed, attachmentToKeep)
        if (handled) {
          setText('')
          onCancelEdit?.()
          inputRef.current?.focus()
        }
      } else {
        // Normal message send
        handled = await onSend(trimmed)
        if (handled) {
          setText('')
          onCancelReply?.()
          inputRef.current?.focus()
        }
      }
    } catch (err) {
      console.error('Failed to send message:', err)
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Don't submit if disabled (e.g., offline)
      if (disabled) return
      void handleSubmit(e)
    } else if (e.key === 'Escape') {
      // Cancel edit mode on Escape
      if (editingMessage && onCancelEdit) {
        e.preventDefault()
        setText('')
        onCancelEdit()
      }
      // Cancel reply mode on Escape
      if (replyingTo && onCancelReply) {
        e.preventDefault()
        onCancelReply()
      }
    } else if (e.key === 'ArrowUp' && !text.trim() && !editingMessage && onEditLastMessage) {
      // Up arrow in empty field triggers editing last message
      e.preventDefault()
      onEditLastMessage()
    }
  }

  const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    onSelectionChange?.(e.currentTarget.selectionStart)
  }

  // Handle clipboard paste - stage files as pending attachment
  // Supports: screenshots, "Copy Image" from browsers, pasted files
  // On Linux/Tauri, WebKitGTK may not expose clipboard images through the web API,
  // so we fall back to native clipboard reading via tauri-plugin-clipboard-manager.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onFileSelect) return

    const clipboardData = e.clipboardData
    if (!clipboardData) return

    // First check clipboardData.files (populated by Safari "Copy Image" and some apps)
    // This takes priority because it contains the actual file with proper metadata
    const files = clipboardData.files
    if (files && files.length > 0) {
      const file = files[0]
      if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
        e.preventDefault()
        onFileSelect(file)
        return
      }
    }

    // Fallback: check clipboardData.items for image data (screenshots, Chrome "Copy Image")
    const items = clipboardData.items
    if (items) {
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault() // Prevent pasting URL as text
            onFileSelect(file)
            return
          }
        }
      }
    }

    // Native fallback: on Tauri (especially Linux/WebKitGTK), the web clipboard API
    // may not expose image data. Try reading from the native system clipboard.
    const types = clipboardData.types || []
    const hasTextContent = types.includes('text/plain') || types.includes('text/html')
    if (!hasTextContent) {
      e.preventDefault()
      void import('@/utils/nativeClipboard').then(({ readClipboardImage }) =>
        readClipboardImage().then((file) => {
          if (file) onFileSelect(file)
        })
      )
    }
  }

  // File upload handlers
  const handleFileClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file && onFileSelect) {
      onFileSelect(file)
    }
    // Reset file input so the same file can be selected again
    e.target.value = ''
  }

  // Insert emoji at cursor position
  const handleEmojiSelect = (emoji: string) => {
    if (!inputRef.current) return

    const cursorPos = inputRef.current.selectionStart ?? text.length
    const newText = text.slice(0, cursorPos) + emoji + text.slice(cursorPos)
    setText(newText)
    setShowEmojiPicker(false)

    // Restore focus and set cursor after emoji
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus()
        const newCursorPos = cursorPos + emoji.length
        inputRef.current.setSelectionRange(newCursorPos, newCursorPos)
      }
    }, 0)
  }

  // Default input renderer (simple textarea)
  const defaultRenderInput = () => (
    <TextArea
      ref={mergedInputRef}
      value={text}
      onChange={handleTextChange}
      onKeyDown={handleKeyDown}
      onSelect={handleSelect}
      onPaste={handlePaste}
      placeholder={placeholder}
      rows={1}
      spellCheck={true}
      autoCorrect="on"
      autoCapitalize="sentences"
      className={`${MESSAGE_INPUT_BASE_CLASSES} ${MESSAGE_INPUT_TEXT_CLASSES}`}
    />
  )

  // Wrapped cancel handler that clears text before calling onCancelEdit
  const handleCancelEdit = () => {
    setText('')
    onCancelEdit?.()
  }

  return (
    <form onSubmit={handleSubmit} className="px-4 pt-2 pb-safe relative">
      {/* Custom content above input (e.g., mention autocomplete) */}
      {aboveInput}

      {/* Edit indicator */}
      {editingMessage && (
        <div className={`bg-fluux-hover rounded-t-lg px-3 py-2 flex items-start gap-2 border-s-2 ${willDeleteMessage ? 'border-red-500' : 'border-green-500'}`}>
          {willDeleteMessage ? (
            <Trash2 className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          ) : (
            <Pencil className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            <p className={`text-xs font-medium ${willDeleteMessage ? 'text-red-500' : 'text-green-500'}`}>
              {willDeleteMessage ? t('chat.deleteMessage') : t('chat.editingMessage')}
            </p>
            <p className="text-xs text-fluux-muted truncate">
              {editingMessage.body}
            </p>
            {/* Show attachment if present and not removed */}
            {editingMessage.attachment && !editAttachmentRemoved && (
              <div className="flex items-center gap-2 mt-1 p-1.5 bg-fluux-bg rounded">
                {editingMessage.attachment.mediaType?.startsWith('image/') ? (
                  <Image className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                ) : (
                  <FileText className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                )}
                <span className="text-xs text-fluux-muted truncate flex-1">
                  {editingMessage.attachment.name || t('chat.attachment')}
                </span>
                <Tooltip content={t('chat.removeAttachment')} position="top">
                  <button
                    type="button"
                    onClick={() => setEditAttachmentRemoved(true)}
                    className="p-0.5 text-fluux-muted hover:text-fluux-red transition-colors flex-shrink-0"
                    aria-label={t('chat.removeAttachment')}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Tooltip>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleCancelEdit}
            className="text-fluux-muted hover:text-fluux-text transition-colors flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Reply preview */}
      {replyingTo && !editingMessage && (
        <div className="bg-fluux-hover rounded-t-lg px-3 py-2 flex items-start gap-2 border-s-2 border-fluux-brand">
          <Reply className="rtl-mirror w-4 h-4 text-fluux-brand flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-fluux-brand">
              Replying to {replyingTo.senderName}
            </p>
            <p className="text-xs text-fluux-muted truncate">
              {replyingTo.body}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            className="text-fluux-muted hover:text-fluux-text transition-colors flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Pending attachment preview */}
      {pendingAttachment && !editingMessage && (
        <div className={`bg-fluux-hover ${replyingTo ? '' : 'rounded-t-lg'} px-3 py-2 flex items-center gap-3 border-s-2 border-fluux-brand`}>
          {/* Thumbnail preview for images/videos */}
          {pendingAttachment.previewUrl && pendingAttachment.file.type.startsWith('image/') ? (
            <img
              src={pendingAttachment.previewUrl}
              alt={pendingAttachment.file.name}
              className="w-12 h-12 object-cover rounded flex-shrink-0"
            />
          ) : pendingAttachment.previewUrl && pendingAttachment.file.type.startsWith('video/') ? (
            <div className="w-12 h-12 relative flex-shrink-0">
              <img
                src={pendingAttachment.previewUrl}
                alt={pendingAttachment.file.name}
                className="w-full h-full object-cover rounded"
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded">
                <div className="w-4 h-4 border-2 border-white rounded-full flex items-center justify-center">
                  <div className="w-0 h-0 border-s-[5px] border-s-white border-y-[3px] border-y-transparent ms-0.5" />
                </div>
              </div>
            </div>
          ) : (
            <div className="w-12 h-12 flex items-center justify-center bg-fluux-bg rounded flex-shrink-0">
              {pendingAttachment.file.type.startsWith('image/') ? (
                <Image className="w-6 h-6 text-fluux-muted" />
              ) : (
                <FileText className="w-6 h-6 text-fluux-muted" />
              )}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-fluux-text truncate">
              {pendingAttachment.file.name}
            </p>
            <p className="text-xs text-fluux-muted">
              {formatFileSize(pendingAttachment.file.size)}
            </p>
          </div>
          <Tooltip content={t('chat.removeAttachment')} position="top">
            <button
              type="button"
              onClick={onRemovePendingAttachment}
              className="p-1 text-fluux-muted hover:text-fluux-red transition-colors flex-shrink-0"
              aria-label={t('chat.removeAttachment')}
            >
              <X className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>
      )}

      <div className={`bg-fluux-hover ${(replyingTo || editingMessage || pendingAttachment) ? 'rounded-b-lg' : 'rounded-lg'} flex items-center`}>
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileChange}
        />

        {/* Attach menu — combines attachment + poll into a single "+" button */}
        <div className="relative" ref={attachMenuRef}>
          {uploadState?.isUploading ? (
            /* During upload, show spinner directly instead of the menu toggle */
            <button type="button" disabled className="p-3 text-fluux-brand">
              <div className="relative w-5 h-5 flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="absolute text-[8px] font-bold">
                  {uploadState.progress}
                </span>
              </div>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setShowAttachMenu(!showAttachMenu)}
              aria-label={t('upload.attachFile')}
              className={`p-3 transition-colors ${showAttachMenu ? 'text-fluux-brand' : 'text-fluux-muted hover:text-fluux-text'}`}
            >
              <Plus className={`w-5 h-5 transition-transform ${showAttachMenu ? 'rotate-45' : ''}`} />
            </button>
          )}

          {showAttachMenu && (
            <div className="absolute bottom-full start-0 mb-2 z-50 bg-fluux-surface border border-fluux-border rounded-lg shadow-lg py-1 min-w-[180px]">
              <button
                type="button"
                onClick={() => {
                  setShowAttachMenu(false)
                  handleFileClick()
                }}
                disabled={!isUploadSupported}
                className={`w-full flex items-center gap-3 px-3 py-2 text-sm text-start transition-colors ${
                  isUploadSupported
                    ? 'text-fluux-text hover:bg-fluux-hover'
                    : 'text-fluux-muted/50 cursor-not-allowed'
                }`}
              >
                <Paperclip className="w-4 h-4 flex-shrink-0" />
                {t('upload.attachFile')}
              </button>
              {onCreatePoll && (
                <button
                  type="button"
                  onClick={() => {
                    setShowAttachMenu(false)
                    onCreatePoll()
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm text-start text-fluux-text hover:bg-fluux-hover transition-colors"
                >
                  <BarChart3 className="w-4 h-4 flex-shrink-0" />
                  {t('poll.create', 'Create Poll')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Text input - either custom or default */}
        {renderInput ? (
          <div className="flex-1 min-w-0 flex items-center relative">
            {renderInput({
              inputRef,
              mergedRef: mergedInputRef,
              value: text,
              onChange: handleTextChange,
              onKeyDown: handleKeyDown,
              onSelect: handleSelect,
              onPaste: handlePaste,
              placeholder,
            })}
          </div>
        ) : (
          defaultRenderInput()
        )}

        {/* Emoji button */}
        <div className="relative" ref={emojiPickerRef}>
          <button
            type="button"
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            onMouseEnter={() => { void emojiPickerImport() }}
            className={`p-3 transition-colors ${showEmojiPicker ? 'text-fluux-brand' : 'text-fluux-muted hover:text-fluux-text'}`}
          >
            <Smile className="w-5 h-5" />
          </button>

          {/* Emoji picker popup (lazy-loaded) */}
          {showEmojiPicker && (
            <div className="absolute bottom-full end-0 mb-2 z-50">
              <Suspense fallback={null}>
                <EmojiPicker
                  onSelect={handleEmojiSelect}
                  onClose={() => setShowEmojiPicker(false)}
                />
              </Suspense>
            </div>
          )}
        </div>

        {/* Send button */}
        <button
          type="submit"
          disabled={(!text.trim() && !pendingAttachment) || sending || disabled}
          className="p-3 text-fluux-brand hover:text-fluux-brand-hover
                     disabled:text-fluux-muted disabled:cursor-not-allowed transition-colors"
        >
          <Send className="rtl-mirror w-5 h-5" />
        </button>
      </div>
    </form>
  )
}
