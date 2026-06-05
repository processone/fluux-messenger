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
  // 1 — Direct messaging + reactions (reel)
  {
    id: 'messaging',
    variant: 'reel',
    run: async (d) => {
      await d.navigateTo('messages')
      await d.selectItem('Emma Wilson')
      await d.caption('Fast, modern messaging', 'Reactions, replies & rich text — built in')
      await d.dwell(1800)
      const msgId = await d.typeBeat({ conversationId: `emma@${DOMAIN}`, from: `emma@${DOMAIN}`, body: 'Perfect — see you at 4! 🎉' })
      await d.chatReaction({ conversationId: `emma@${DOMAIN}`, messageId: msgId, reactorJid: SELF_JID, emojis: ['👍'] })
      await d.dwell(1200)
      await d.clearCaption()
    },
  },

  // 2 — Command palette (reel)
  {
    id: 'command-palette',
    variant: 'reel',
    run: async (d) => {
      await d.caption('Jump anywhere', 'Command palette — ⌘K')
      await d.press('Meta+k', 800)
      await d.typeText('design')
      await d.dwell(900)
      // Click the result to jump straight into it (the Design Review room).
      // A room result is unique to the palette (rooms aren't in the messages
      // sidebar), so the click isn't blocked by the modal backdrop — and it's
      // a different destination from the Team Chat rooms scene, so no repeat.
      await d.glideClick(d.page.getByText('Design Review', { exact: true }).first(), 1500)
      await d.clearCaption()
    },
  },

  // 3 — Group rooms + members + live room message (reel)
  {
    id: 'rooms',
    variant: 'reel',
    run: async (d) => {
      await d.navigateTo('rooms')
      await d.selectItem('Team Chat')
      await d.caption('Group chat & rooms', 'MUC rooms with presence, roles & members')
      const membersBtn = d.page.locator('button[aria-label="Show members"]')
      if (await membersBtn.isVisible().catch(() => false)) await d.glideClick(membersBtn, 1000)
      await d.roomBeat({ roomJid: ROOM_JID, nick: 'James', body: 'Pushed the fix — CI is green ✅' })
      await d.dwell(1400)
      await d.clearCaption()
    },
  },

  // 4 — Polls & code blocks (full only)
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

  // 5 — Whispers (full only)
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

  // 6 — End-to-end encryption badges (reel)
  {
    id: 'encryption',
    variant: 'reel',
    run: async (d) => {
      await d.navigateTo('messages')
      await d.selectItem('Ava Martinez')
      await d.caption('End-to-end encryption', 'OpenPGP with verified / TOFU trust states')
      await d.dwell(3000)
      await d.clearCaption()
    },
  },

  // 7 — Encryption settings (full only)
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

  // 8 — Themes & dark/light (reel)
  {
    id: 'themes',
    variant: 'reel',
    run: async (d) => {
      await d.navigateTo('messages')
      await d.selectItem('Emma Wilson')
      await d.caption('Make it yours', 'Light & dark, plus curated themes')
      await d.setColorScheme('light', 1400)
      await d.setTheme('nord', 1300)
      await d.setTheme('dracula', 1300)
      await d.setTheme('fluux')
      await d.setColorScheme('dark', 900)
      await d.clearCaption()
    },
  },

  // 9 — Global search (full only)
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

  // 10 — i18n / RTL (full only)
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

  // 11 — Admin console (full only)
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
