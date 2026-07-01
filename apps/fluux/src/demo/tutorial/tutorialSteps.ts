/**
 * Tutorial step definitions — each maps to a stepId fired by the animation timeline.
 *
 * Text content (content / actionHint) lives in the tutorial i18n namespace
 * (see locales/*.ts), keyed by step id. The fields on TutorialStep are optional
 * fallbacks only.
 *
 * Selectors target stable attributes:
 *   - [data-nav="<view>"] on sidebar nav buttons (via IconRailNavLink)
 *   - [aria-label="..."] on action buttons
 *   - Tailwind utility classes for structural elements (message images, scroll containers)
 *
 * Flow: basics first, progressive complexity.
 *   Act 1 — Welcome & Navigation
 *   Act 2 — Rooms & Group Chat
 *   Act 3 — Rich Media & Files
 *   Act 4 — Activity, Search & Mentions
 *   Act 5 — Customization & Power Features
 *   Act 6 — Admin & Wrap-up
 */

import type { TutorialStep } from './types'

export const TUTORIAL_STEPS: TutorialStep[] = [
  // ── Act 1: Welcome & Navigation ───────────────────────────────────────
  {
    id: 'welcome-hint',
    targetSelector: 'body',
    position: 'bottom',
    completionTrigger: { type: 'timeout', ms: 8_000 },
    maxWaitMs: 15_000,
  },
  {
    id: 'conversations-hint',
    targetSelector: 'aside h1',
    position: 'right',
    completionTrigger: { type: 'click', selector: '[data-nav="messages"]' },
    maxWaitMs: 20_000,
  },

  // ── Act 2: Rooms & Group Chat ─────────────────────────────────────────
  {
    id: 'rooms-hint',
    targetSelector: '[data-nav="rooms"]',
    position: 'right',
    completionTrigger: { type: 'click', selector: '[data-nav="rooms"]' },
    maxWaitMs: 30_000,
  },

  // ── Act 3: Rich Media & Files ─────────────────────────────────────────
  {
    id: 'image-hint',
    targetSelector: 'main img.max-w-full',
    position: 'bottom',
    completionTrigger: { type: 'dom-appears', selector: '.fixed.inset-0.bg-black\\/90' },
    maxWaitMs: 45_000,
  },
  {
    id: 'file-upload-hint',
    targetSelector: 'button[aria-label*="ttach"], button[aria-label*="ichier"]',
    position: 'top',
    completionTrigger: { type: 'timeout', ms: 8_000 },
    maxWaitMs: 30_000,
  },

  // ── Act 4: Search & Mentions ────────────────────────────────
  {
    id: 'search-hint',
    targetSelector: '[data-nav="search"]',
    position: 'right',
    completionTrigger: { type: 'click', selector: '[data-nav="search"]' },
    maxWaitMs: 45_000,
  },
  {
    id: 'mention-hint',
    targetSelector: '[data-nav="rooms"]',
    position: 'right',
    completionTrigger: { type: 'timeout', ms: 10_000 },
    maxWaitMs: 30_000,
  },

  // ── Act 5: Customization & Power Features ─────────────────────────────
  {
    id: 'keyboard-shortcuts-hint',
    targetSelector: 'body',
    position: 'bottom',
    completionTrigger: { type: 'dom-appears', selector: '[role="dialog"]' },
    maxWaitMs: 30_000,
  },
  {
    id: 'theme-hint',
    targetSelector: '[data-nav="settings"]',
    position: 'right',
    completionTrigger: { type: 'navigate', hash: '#/settings' },
    maxWaitMs: 45_000,
  },

  // ── Act 6: Admin & Wrap-up ────────────────────────────────────────────
  {
    id: 'admin-hint',
    targetSelector: '[data-nav="admin"]',
    position: 'right',
    completionTrigger: { type: 'click', selector: '[data-nav="admin"]' },
    maxWaitMs: 30_000,
  },
  {
    id: 'xmpp-console-hint',
    targetSelector: '[data-nav="settings"]',
    position: 'right',
    completionTrigger: { type: 'timeout', ms: 10_000 },
    maxWaitMs: 30_000,
  },
  {
    id: 'tour-complete',
    targetSelector: 'body',
    position: 'bottom',
    completionTrigger: { type: 'timeout', ms: 15_000 },
    maxWaitMs: 20_000,
  },
]

/** Lookup a tutorial step by ID. */
export function getTutorialStep(stepId: string): TutorialStep | undefined {
  return TUTORIAL_STEPS.find(s => s.id === stepId)
}
