import { beforeEach, describe, expect, it } from 'vitest'
import { scrollStateManager } from '@/utils/scrollStateManager'
import { ScrollPersistenceAdapter } from './scrollPersistenceAdapter'
import { ViewportSession, type ViewportGeometry } from './viewportSession'

const conversationId = 'room-a'
const savedGeometry = { top: 640, height: 2000, client: 500 }

beforeEach(() => scrollStateManager.reset())

function restoreSession() {
  scrollStateManager.enterConversation(conversationId, 40)
  scrollStateManager.leaveConversation(conversationId, 640, 2000, 500)
  const persistence = new ScrollPersistenceAdapter()
  expect(persistence.enterConversation(conversationId, 40)).toMatchObject({
    action: 'restore-position', savedOffsetPx: 640,
  })
  const session = new ViewportSession(conversationId)
  session.recordProgrammaticWrite(conversationId, 1000, savedGeometry)
  session.recordViewport(conversationId, savedGeometry, null)
  return { session, persistence }
}

describe('live message-list scroll ownership', () => {
  it.each([false, true])('persists movement sampled before scroll delivery (save during scroll: %s)', saveDuringScroll => {
    const { session, persistence } = restoreSession()
    const geometry = { ...savedGeometry, top: 590 }
    expect(session.observeGeometry(conversationId, geometry, {
      now: 1100, controllerOwnsPixels: false,
    })?.userDelta).toBe(-50)
    expect(session.hasGenuineInput(conversationId)).toBe(true)
    expect(session.observeScroll({
      conversationId, geometry, bottomAnchor: null,
      now: 1600, controllerOwnsPixels: false,
    })).toMatchObject({ userDelta: 0, userScrollGeometry: geometry })

    const outgoing = session.snapshotFor(conversationId)
    if (saveDuringScroll) {
      expect(persistence.persistViewport({
        conversationId, snapshot: outgoing, readPositionId: undefined,
        now: 1600, controllerOwnsPixels: false,
      })).toBe(true)
      expect(scrollStateManager.getSavedScrollTop(conversationId)).toBe(590)
    }
    expect(persistence.leaveConversation(conversationId, outgoing, undefined)).toBe('saved')
    session.enterConversation('room-b')
    expect(session.hasGenuineInput('room-b')).toBe(false)
    expect(persistence.enterConversation(conversationId, 40)).toMatchObject({
      action: 'restore-position', savedOffsetPx: 590,
    })
  })

  it.each(['stationary', 'layout-write', 'clamp', 'animation'] as const)(
    'preserves the saved position after a sampled %s', kind => {
      const { session, persistence } = restoreSession()
      const geometry: ViewportGeometry = kind === 'clamp'
        ? { top: 500, height: 1000, client: 500 }
        : { ...savedGeometry, top: kind === 'stationary' ? 640 : 590 }
      if (kind === 'layout-write' || kind === 'animation') session.recordProgrammaticWrite(conversationId, 1100, geometry)
      expect(session.observeGeometry(conversationId, geometry, {
        now: 1100, controllerOwnsPixels: kind === 'animation',
      })?.userDelta).toBe(0)
      expect(session.observeScroll({
        conversationId, geometry, bottomAnchor: null,
        now: 1600, controllerOwnsPixels: false,
      })).toMatchObject({ userDelta: 0, userScrollGeometry: null })
      const outgoing = session.snapshotFor(conversationId)
      expect(persistence.persistViewport({
        conversationId, snapshot: outgoing, readPositionId: undefined,
        now: 1600, controllerOwnsPixels: false,
      })).toBe(false)
      expect(persistence.leaveConversation(conversationId, outgoing, undefined)).toBe('marked-left')
      expect(persistence.enterConversation(conversationId, 40)).toMatchObject({
        action: 'restore-position', savedOffsetPx: 640,
      })
    },
  )
})
