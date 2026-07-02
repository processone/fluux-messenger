/**
 * Ordered storyboard for the Fluux demo video.
 *
 * Each scene declares the minimum `variant` it belongs to:
 *   - 'reel' scenes appear in BOTH the short reel and the full tour
 *   - 'full' scenes appear ONLY in the full tour
 *
 * Scenes drive a Director, which captures one native-resolution frame per step.
 */

import { DOMAIN, ROOM_JID, SELF_JID } from './helpers'
import { type Director } from './director'

export type Variant = 'reel' | 'full'

export interface Scene {
  id: string
  variant: Variant
  run: (d: Director) => Promise<void>
}

export const storyboard: Scene[] = [
  // 1 — Direct messaging + typing + reaction (reel)
  {
    id: 'messaging',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('messages'); await d.selectItem('Emma Wilson') })
      await d.caption('Fast, modern messaging', 'Typing indicators, reactions & replies — built in')
      const msgId = await d.typeBeat({ conversationId: `emma@${DOMAIN}`, from: `emma@${DOMAIN}`, body: 'Perfect — see you at 4! 🎉' })
      await d.chatReaction({ conversationId: `emma@${DOMAIN}`, messageId: msgId, reactorJid: SELF_JID, emojis: ['👍'] })
      await d.absorb()
      await d.clearCaption()
    },
  },

  // 2 — Replies & rich text / markdown (reel)
  {
    id: 'replies-richtext',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('rooms'); await d.selectItem('Team Chat') })
      await d.caption('Replies & rich text', 'Markdown, code blocks & quoted replies')
      const codeId = 'demo-vid-code'
      await d.roomBeat({
        roomJid: ROOM_JID, nick: 'Sophia', id: codeId,
        body: 'Optimized the XML parser:\n\n```rust\npub fn parse(input: &[u8]) -> Result<Stanza, Error> {\n    let mut r = Reader::from_reader(input);\n    r.config_mut().trim_text(true);\n    Stanza::read(&mut r)\n}\n```\n\n3× faster than before 🏎️',
      })
      await d.absorb()
      await d.roomBeat({
        roomJid: ROOM_JID, nick: 'Emma',
        body: 'Nice catch — that explains the heap growth I saw in the profiler',
        replyTo: { id: codeId, to: `${ROOM_JID}/Sophia`, fallbackBody: 'Optimized the XML parser' },
      })
      await d.absorb()
      await d.clearCaption()
    },
  },

  // 3 — File & image sharing (reel)
  {
    id: 'file-sharing',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('messages'); await d.selectItem('Emma Wilson') })
      await d.caption('Share files & images', 'Images, PDFs & voice notes — with inline previews')
      await d.attachmentBeat({
        conversationId: `emma@${DOMAIN}`,
        body: 'Here’s the latest mockup 👇',
        attachment: { url: './demo/screenshot-chat-dark.png', name: 'mockup-v2.png', mediaType: 'image/png', size: 384_000, width: 1280, height: 800 },
      })
      await d.absorb()
      await d.clearCaption()
    },
  },

  // 4 — Edit & retraction (reel)
  {
    id: 'edit-retract',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('messages'); await d.selectItem('Emma Wilson') })
      await d.caption('Edit & unsend', 'Fix a typo or retract a message (XEP-0308 / XEP-0424)')
      const editId = await d.typeBeat({ conversationId: `emma@${DOMAIN}`, from: `emma@${DOMAIN}`, body: 'Lunch at 12:30 sharp!' })
      await d.absorb()
      await d.editMessage({ conversationId: `emma@${DOMAIN}`, messageId: editId, body: 'Lunch at 1:00 sharp!' })
      await d.absorb()
      const dropId = await d.typeBeat({ conversationId: `emma@${DOMAIN}`, from: `emma@${DOMAIN}`, body: 'Wrong chat, ignore that 🙈' })
      await d.absorb()
      await d.retractMessage({ conversationId: `emma@${DOMAIN}`, messageId: dropId })
      await d.absorb()
      await d.clearCaption()
    },
  },

  // 5 — Command palette (reel)
  {
    id: 'command-palette',
    variant: 'reel',
    run: async (d) => {
      await d.caption('Jump anywhere', 'Command palette — ⌘K')
      await d.press('Meta+k', 800)
      await d.typeText('design')
      await d.dwell(900)
      await d.glideClick(d.page.getByText('Design Review', { exact: true }).first(), 1500)
      await d.clearCaption()
    },
  },

  // 6 — Group rooms + presence + members (reel)
  {
    id: 'rooms-presence',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('rooms'); await d.selectItem('Team Chat') })
      await d.caption('Group chat & rooms', 'MUC rooms with presence, roles & members')
      const membersBtn = d.page.locator('button[aria-label="Show members"]')
      if (await membersBtn.isVisible().catch(() => false)) await d.glideClick(membersBtn, 1000)
      await d.presence({ fullJid: `sophia@${DOMAIN}/laptop`, show: null })
      await d.roomBeat({ roomJid: ROOM_JID, nick: 'James', body: 'Pushed the fix — CI is green ✅' })
      await d.absorb()
      await d.clearCaption()
    },
  },

  // 7 — End-to-end encryption (reel)
  {
    id: 'encryption',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('messages'); await d.selectItem('Ava Martinez') })
      await d.caption('End-to-end encryption', 'OpenPGP with verified / TOFU trust states')
      await d.absorb()
      await d.dwell(1400)
      await d.clearCaption()
    },
  },

  // 8 — Themes & dark/light (reel)
  {
    id: 'themes',
    variant: 'reel',
    run: async (d) => {
      await d.crossfade(async () => { await d.navigateTo('messages'); await d.selectItem('Emma Wilson') })
      await d.caption('Make it yours', 'Light & dark, plus curated themes')
      await d.setColorScheme('light', 1400)
      await d.setTheme('nord', 1300)
      await d.setTheme('dracula', 1300)
      await d.setTheme('fluux')
      await d.setColorScheme('dark', 900)
      await d.clearCaption()
    },
  },

  // 9 — Polls & code blocks (full only)
  {
    id: 'poll-code',
    variant: 'full',
    run: async (d) => {
      await d.navigateTo('rooms')
      await d.selectItem('Team Chat')
      await d.caption('Polls & code sharing', 'Syntax-highlighted code and built-in polls')
      await d.scrollLocator(d.page.locator('[class*="poll" i]').first(), 2000)
      await d.scrollLocator(d.page.locator('pre code').first(), 2000)
      await d.clearCaption()
    },
  },

  // 10 — Whispers (full only)
  {
    id: 'whisper',
    variant: 'full',
    run: async (d) => {
      await d.navigateTo('rooms')
      await d.selectItem('Team Chat')
      await d.caption('Private whispers', 'One-to-one messages inside a room (XEP-0045)')
      await d.scrollTo('Private with Emma', 2200)
      await d.clearCaption()
    },
  },

  // 11 — Encryption settings (full only)
  {
    id: 'encryption-settings',
    variant: 'full',
    run: async (d) => {
      await d.navigateTo('settings')
      await d.glideClick(d.page.getByText('Encryption', { exact: true }).first(), 700)
      await d.page.locator('code').filter({ hasText: 'BAF0' }).first().waitFor({ timeout: 6_000 }).catch(() => {})
      await d.caption('Your keys, your control', 'Fingerprint, backup, export & key rotation')
      await d.dwell(2800)
      await d.clearCaption()
    },
  },

  // 12 — Global search (full only)
  {
    id: 'search',
    variant: 'full',
    run: async (d) => {
      await d.navigateTo('search')
      await d.caption('Search everything', 'Full-text search across conversations & rooms')
      await d.glideClick(d.page.locator('input[type="text"]').first(), 400)
      await d.typeText('design')
      await d.dwell(1400)
      const firstResult = d.page.locator('[data-search-result-id]').first()
      if (await firstResult.isVisible().catch(() => false)) await d.glideClick(firstResult, 1800)
      await d.clearCaption()
    },
  },

  // 13 — i18n / RTL (full only)
  {
    id: 'i18n',
    variant: 'full',
    run: async (d) => {
      await d.navigateTo('messages')
      await d.selectItem('Emma Wilson')
      await d.caption('33 languages · full RTL', 'Right-to-left layouts, fully mirrored')
      await d.setLanguage('ar', 3000)
      await d.setLanguage('en', 800)
      await d.clearCaption()
    },
  },

  // 14 — Admin console (full only)
  {
    id: 'admin',
    variant: 'full',
    run: async (d) => {
      await d.navigateTo('admin')
      await d.glideClick(d.page.getByText('Users', { exact: true }).first(), 700)
      // In demo mode fetchUsers() has no server — reseed the list (as in screenshots.ts).
      await d.page.evaluate(() => {
        const adminStore = (window as any).__adminStore
        if (!adminStore) return
        adminStore.getState().setUserList({
          items: [
            { jid: 'emma@fluux.chat', username: 'emma', isOnline: true },
            { jid: 'james@fluux.chat', username: 'james', isOnline: true },
            { jid: 'sophia@fluux.chat', username: 'sophia', isOnline: true },
            { jid: 'olivia@fluux.chat', username: 'olivia', isOnline: true },
            { jid: 'mia@fluux.chat', username: 'mia', isOnline: false },
            { jid: 'liam@fluux.chat', username: 'liam', isOnline: true },
            { jid: 'ava@fluux.chat', username: 'ava', isOnline: true },
            { jid: 'alex@fluux.chat', username: 'alex', isOnline: false },
          ],
          isLoading: false, error: null, searchQuery: '', hasFetched: true,
          pagination: { count: 8 },
        })
      })
      await d.caption('Built-in admin console', 'Manage users, rooms & the server (ejabberd / XEP-0133)')
      await d.dwell(3000)
      await d.clearCaption()
    },
  },
]

/** Scenes for a given variant, in storyboard order. */
export function scenesFor(variant: Variant): Scene[] {
  return variant === 'full' ? storyboard : storyboard.filter((s) => s.variant === 'reel')
}
