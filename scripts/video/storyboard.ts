/**
 * Ordered storyboard for the Fluux demo video.
 *
 * Each scene declares the minimum `variant` it belongs to:
 *   - 'reel' scenes appear in BOTH the short reel and the full tour
 *   - 'full' scenes appear ONLY in the full tour
 *
 * The array is in full-tour order; filtering to 'reel' keeps a sensible
 * subset flow. Scenes drive navigation deterministically and fire "live
 * beats" so the app feels real-time on camera.
 */

import { type Page } from '@playwright/test'
import {
  DOMAIN, ROOM_JID,
  showCaption, hideCaption, dwell, navigateTo, selectItem, glideClick,
  setTheme, setColorScheme, setLanguage, scrollToText,
  beatIncomingChat, beatChatReaction, beatRoomMessage,
} from './helpers'

export type Variant = 'reel' | 'full'

export interface Scene {
  id: string
  variant: Variant
  run: (page: Page) => Promise<void>
}

export const storyboard: Scene[] = [
  // 1 — Direct messaging + reactions/replies (reel)
  {
    id: 'messaging',
    variant: 'reel',
    run: async (page) => {
      await navigateTo(page, 'messages')
      await selectItem(page, 'Emma Wilson')
      await showCaption(page, 'Fast, modern messaging', 'Reactions, replies & rich text — built in')
      await dwell(page, 2200)
      const msgId = await beatIncomingChat(page, {
        conversationId: `emma@${DOMAIN}`,
        from: `emma@${DOMAIN}`,
        body: 'Perfect — see you at 4! 🎉',
      })
      await dwell(page, 900)
      await beatChatReaction(page, {
        conversationId: `emma@${DOMAIN}`,
        messageId: msgId,
        reactorJid: `you@${DOMAIN}`,
        emojis: ['👍'],
      })
      await dwell(page, 1500)
      await hideCaption(page)
    },
  },

  // 2 — Command palette (reel)
  {
    id: 'command-palette',
    variant: 'reel',
    run: async (page) => {
      await showCaption(page, 'Jump anywhere', 'Command palette — ⌘K')
      await page.keyboard.press('Meta+k')
      await dwell(page, 900)
      await page.keyboard.type('team', { delay: 130 })
      await dwell(page, 2000)
      await page.keyboard.press('Escape')
      await dwell(page, 600)
      await hideCaption(page)
    },
  },

  // 3 — Group rooms + members + live room message (reel)
  {
    id: 'rooms',
    variant: 'reel',
    run: async (page) => {
      await navigateTo(page, 'rooms')
      await selectItem(page, 'Team Chat')
      await showCaption(page, 'Group chat & rooms', 'MUC rooms with presence, roles & members')
      const membersBtn = page.locator('button[aria-label="Show members"]')
      if (await membersBtn.isVisible().catch(() => false)) {
        await dwell(page, 600)
        await membersBtn.click()
        await dwell(page, 1200)
      }
      await beatRoomMessage(page, { roomJid: ROOM_JID, nick: 'James', body: 'Pushed the fix — CI is green ✅' })
      await dwell(page, 1600)
      await hideCaption(page)
    },
  },

  // 4 — Polls & code blocks (full only)
  {
    id: 'poll-code',
    variant: 'full',
    run: async (page) => {
      await navigateTo(page, 'rooms')
      await selectItem(page, 'Team Chat')
      await showCaption(page, 'Polls & code sharing', 'Syntax-highlighted code and built-in polls')
      const poll = page.locator('[class*="poll" i]').first()
      if (await poll.isVisible().catch(() => false)) {
        await poll.scrollIntoViewIfNeeded()
        await dwell(page, 2000)
      }
      const code = page.locator('pre code').first()
      if (await code.isVisible().catch(() => false)) {
        await code.scrollIntoViewIfNeeded()
        await dwell(page, 2000)
      }
      await hideCaption(page)
    },
  },

  // 5 — Whispers (full only)
  {
    id: 'whisper',
    variant: 'full',
    run: async (page) => {
      await navigateTo(page, 'rooms')
      await selectItem(page, 'Team Chat')
      await showCaption(page, 'Private whispers', 'One-to-one messages inside a room (XEP-0045)')
      await scrollToText(page, 'Private with Emma')
      await dwell(page, 2200)
      await hideCaption(page)
    },
  },

  // 6 — End-to-end encryption badges (reel)
  {
    id: 'encryption',
    variant: 'reel',
    run: async (page) => {
      await navigateTo(page, 'messages')
      await selectItem(page, 'Ava Martinez')
      await showCaption(page, 'End-to-end encryption', 'OpenPGP with verified / TOFU trust states')
      await dwell(page, 3200)
      await hideCaption(page)
    },
  },

  // 7 — Encryption settings (full only)
  {
    id: 'encryption-settings',
    variant: 'full',
    run: async (page) => {
      await navigateTo(page, 'settings')
      await glideClickText(page, 'Encryption')
      await page.locator('code').filter({ hasText: 'BAF0' }).first()
        .waitFor({ timeout: 6_000 }).catch(() => {})
      await showCaption(page, 'Your keys, your control', 'Fingerprint, backup, export & key rotation')
      await dwell(page, 3000)
      await hideCaption(page)
    },
  },

  // 8 — Themes & dark/light (reel)
  {
    id: 'themes',
    variant: 'reel',
    run: async (page) => {
      await navigateTo(page, 'messages')
      await selectItem(page, 'Emma Wilson')
      await showCaption(page, 'Make it yours', 'Light & dark, plus curated themes')
      await setColorScheme(page, 'light')
      await dwell(page, 1500)
      await setTheme(page, 'nord')
      await dwell(page, 1400)
      await setTheme(page, 'dracula')
      await dwell(page, 1400)
      // Reset to the default ('fluux') dark look for any following scenes.
      await setTheme(page, 'fluux')
      await setColorScheme(page, 'dark')
      await dwell(page, 900)
      await hideCaption(page)
    },
  },

  // 9 — Global search (full only)
  {
    id: 'search',
    variant: 'full',
    run: async (page) => {
      await navigateTo(page, 'search')
      await showCaption(page, 'Search everything', 'Full-text search across conversations & rooms')
      const input = page.locator('input[type="text"]').first()
      await input.click()
      await page.keyboard.type('design', { delay: 120 })
      await dwell(page, 1600)
      const firstResult = page.locator('[data-search-result-id]').first()
      if (await firstResult.isVisible().catch(() => false)) {
        await firstResult.click()
        await dwell(page, 1800)
      }
      await hideCaption(page)
    },
  },

  // 10 — i18n / RTL (full only)
  {
    id: 'i18n',
    variant: 'full',
    run: async (page) => {
      await navigateTo(page, 'messages')
      await selectItem(page, 'Emma Wilson')
      await showCaption(page, '33 languages · full RTL', 'Right-to-left layouts, fully mirrored')
      await setLanguage(page, 'ar')
      await dwell(page, 3000)
      await setLanguage(page, 'en')
      await dwell(page, 800)
      await hideCaption(page)
    },
  },

  // 11 — Admin console (full only)
  {
    id: 'admin',
    variant: 'full',
    run: async (page) => {
      await navigateTo(page, 'admin')
      await glideClickText(page, 'Users')
      // In demo mode fetchUsers() has no server — reseed the list (as in screenshots.ts).
      await page.evaluate(() => {
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
      await showCaption(page, 'Built-in admin console', 'Manage users, rooms & the server (ejabberd / XEP-0133)')
      await dwell(page, 3000)
      await hideCaption(page)
    },
  },
]

/** Glide-click a settings/admin category by its visible label. */
async function glideClickText(page: Page, label: string): Promise<void> {
  await glideClick(page, page.getByText(label, { exact: true }).first(), 900)
}

/** Scenes for a given variant, in storyboard order. */
export function scenesFor(variant: Variant): Scene[] {
  return variant === 'full' ? storyboard : storyboard.filter((s) => s.variant === 'reel')
}
