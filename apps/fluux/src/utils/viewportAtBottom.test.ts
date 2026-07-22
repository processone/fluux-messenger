import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerViewportBottomRef,
  isViewportAtBottom,
  _resetViewportRegistryForTesting,
} from './viewportAtBottom'

const ROOM = 'team@conf.example.com'
const CONV = 'alice@example.com'

describe('viewportAtBottom', () => {
  beforeEach(() => {
    _resetViewportRegistryForTesting()
  })

  // A read position must never be invented for a view we cannot see. An unknown
  // id is the state during mount, after unmount, and for every backgrounded view.
  it('reports false for an unregistered view', () => {
    expect(isViewportAtBottom('room', ROOM)).toBe(false)
  })

  it('reads the ref live rather than snapshotting at registration', () => {
    const ref = { current: true }
    registerViewportBottomRef('room', ROOM, ref)
    expect(isViewportAtBottom('room', ROOM)).toBe(true)

    // The scroll hook mutates .current from many call sites and notifies nobody.
    ref.current = false
    expect(isViewportAtBottom('room', ROOM)).toBe(false)
  })

  it('stops reporting once the view unregisters', () => {
    const unregister = registerViewportBottomRef('room', ROOM, { current: true })
    unregister()
    expect(isViewportAtBottom('room', ROOM)).toBe(false)
  })

  it('namespaces rooms and conversations that share an id', () => {
    registerViewportBottomRef('room', 'shared@example.com', { current: true })
    registerViewportBottomRef('conversation', 'shared@example.com', { current: false })

    expect(isViewportAtBottom('room', 'shared@example.com')).toBe(true)
    expect(isViewportAtBottom('conversation', 'shared@example.com')).toBe(false)
  })

  it('replaces the registration when a view remounts', () => {
    registerViewportBottomRef('room', ROOM, { current: false })
    registerViewportBottomRef('room', ROOM, { current: true })
    expect(isViewportAtBottom('room', ROOM)).toBe(true)
  })

  // React runs the new effect before the old cleanup on a remount. A naive
  // delete would then drop the LIVE registration and silently disable the gate.
  it('ignores a stale unregister after a remount replaced the ref', () => {
    const staleUnregister = registerViewportBottomRef('room', ROOM, { current: false })
    registerViewportBottomRef('room', ROOM, { current: true })

    staleUnregister()

    expect(isViewportAtBottom('room', ROOM)).toBe(true)
  })

  it('keeps other views registered when one unregisters', () => {
    registerViewportBottomRef('room', ROOM, { current: true })
    const unregisterConv = registerViewportBottomRef('conversation', CONV, { current: true })

    unregisterConv()

    expect(isViewportAtBottom('conversation', CONV)).toBe(false)
    expect(isViewportAtBottom('room', ROOM)).toBe(true)
  })
})
