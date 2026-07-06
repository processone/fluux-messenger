/**
 * Act 5 — Customization & Power Features (3:15–4:15)
 * Keyboard shortcuts, theme/language, code highlights, moderation (ambient).
 */

import type { DemoAnimationStep } from '@fluux/sdk/demo'
import { DOMAIN, ROOM_JID, DESIGN_ROOM_JID } from '../constants'

export const act5Steps: DemoAnimationStep[] = [
  // Tutorial: keyboard shortcuts
  {
    delayMs: 195_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'keyboard-shortcuts-hint' },
  },
  // James sends a Python code block
  {
    delayMs: 205_000,
    action: 'message',
    data: {
      message: {
        type: 'chat', id: 'demo-anim-james-python', from: `james@${DOMAIN}`,
        body: 'Here\'s the migration script for the new schema:\n\n```python\nfrom alembic import op\nimport sqlalchemy as sa\n\ndef upgrade():\n    op.create_table(\n        "message_archive",\n        sa.Column("id", sa.BigInteger, primary_key=True),\n        sa.Column("jid", sa.String(255), nullable=False),\n        sa.Column("body", sa.Text),\n        sa.Column("timestamp", sa.DateTime, server_default=sa.func.now()),\n        sa.Index("idx_archive_jid_ts", "jid", "timestamp"),\n    )\n```\n\nShould be backwards compatible with the existing tables.',
        timestamp: new Date(), isOutgoing: false, conversationId: `james@${DOMAIN}`,
      },
    },
  },
  // Tutorial: theme/language/customization
  {
    delayMs: 210_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'theme-hint' },
  },
  // Mia posts a message in Design room (will be moderated)
  {
    delayMs: 220_000,
    action: 'room-message',
    data: {
      roomJid: DESIGN_ROOM_JID,
      message: {
        type: 'groupchat', id: 'demo-anim-design-spam', from: `${DESIGN_ROOM_JID}/Mia`, nick: 'Mia',
        body: 'Oops, pasted the wrong config — please ignore!',
        timestamp: new Date(), isOutgoing: false, roomJid: DESIGN_ROOM_JID,
      },
      incrementUnread: true,
    },
  },
  // Moderator deletes it
  {
    delayMs: 225_000,
    action: 'room-message-updated',
    data: {
      roomJid: DESIGN_ROOM_JID,
      messageId: 'demo-anim-design-spam',
      updates: {
        body: '',
        isRetracted: true,
        retractedAt: new Date(),
        isModerated: true,
        moderatedBy: 'Olivia',
        moderationReason: 'Contained sensitive config values',
      },
    },
  },
  // More poll votes trickle in
  {
    delayMs: 235_000,
    action: 'room-reaction',
    data: {
      roomJid: ROOM_JID,
      messageId: 'demo-anim-poll',
      reactorNick: 'James',
      emojis: ['1️⃣'],
    },
  },
  {
    delayMs: 237_000,
    action: 'room-reaction',
    data: {
      roomJid: ROOM_JID,
      messageId: 'demo-anim-poll',
      reactorNick: 'Sophia',
      emojis: ['2️⃣'],
    },
  },
  {
    delayMs: 239_000,
    action: 'room-reaction',
    data: {
      roomJid: ROOM_JID,
      messageId: 'demo-anim-poll',
      reactorNick: 'Liam',
      emojis: ['1️⃣'],
    },
  },
]
