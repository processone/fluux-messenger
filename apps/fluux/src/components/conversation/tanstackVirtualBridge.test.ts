import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from '@tanstack/react-virtual'
import {
  LIBRARY_PRIVATE_NAMES,
  applyLibraryAdjustment,
  awaitingCommandReadBack,
  canWriteScroll,
  clampedWrite,
  hasLibraryAdjustment,
  hasPendingFling,
  heldOffset,
  iosGesture,
  libraryCommand,
  missingLibraryNames,
  retargetLibraryWrite,
  trackCommitUpdate,
} from './tanstackVirtualBridge'

// The version lock (apps/fluux/package.json holds react-virtual at exactly this version, which
// fixes virtual-core) and the private names in tanstackVirtualBridge.ts are one contract: a library
// update is a deliberate change to both this file and the bridge, never a silent drift.
const LOCKED = { reactVirtual: '3.14.28', virtualCore: '3.19.13' } as const

function liveVirtualizer() {
  const scroller = document.createElement('div')
  document.body.append(scroller)
  return new Virtualizer<HTMLElement, Element>({
    count: 10,
    getScrollElement: () => scroller,
    estimateSize: () => 50,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
  })
}

describe('tanstack virtual bridge contract', () => {
  it('runs against exactly the locked library versions', () => {
    const require = createRequire(import.meta.url)
    const reactVirtual = require('@tanstack/react-virtual/package.json').version
    const reactVirtualDir = require.resolve('@tanstack/react-virtual/package.json')
    const virtualCore = createRequire(reactVirtualDir)('@tanstack/virtual-core/package.json').version
    expect({ reactVirtual, virtualCore }).toEqual(LOCKED)
  })

  it('finds every private name the adapter relies on on a live virtualizer', () => {
    expect(Object.keys(LIBRARY_PRIVATE_NAMES)).toHaveLength(11)
    expect(missingLibraryNames(liveVirtualizer())).toEqual([])
  })

  it('names the ones a renamed library no longer presents', () => {
    expect(missingLibraryNames({ _holdOffset: 0 })).toEqual(
      Object.keys(LIBRARY_PRIVATE_NAMES).filter(name => name !== '_holdOffset'),
    )
  })

  it('reads the idle library state through its accessors', () => {
    const virtualizer = liveVirtualizer()
    expect(libraryCommand(virtualizer)).toBeNull()
    expect(heldOffset(virtualizer)).toBe(0)
    expect(clampedWrite(virtualizer)).toBeNull()
    expect(canWriteScroll(virtualizer)).toBe(true)
    expect(awaitingCommandReadBack(virtualizer)).toBe(false)
    expect(hasPendingFling(virtualizer)).toBe(false)
    expect(typeof iosGesture(virtualizer)?.tail).toBe('function')
    expect(typeof iosGesture(virtualizer)?.end).toBe('function')
    expect(hasLibraryAdjustment(virtualizer)).toBe(true)
    expect(typeof applyLibraryAdjustment(virtualizer, 0)).toBe('boolean')
  })

  it('wraps the commit-time update once and reports the commit around it', () => {
    const virtualizer = liveVirtualizer()
    const states: boolean[] = []
    const willUpdate = vi.spyOn(virtualizer, '_willUpdate')
    trackCommitUpdate(virtualizer, committing => states.push(committing))
    trackCommitUpdate(virtualizer, committing => states.push(committing))
    virtualizer._willUpdate()
    expect(states).toEqual([true, false])
    expect(willUpdate).toHaveBeenCalledOnce()
  })

  it('moves the library write record and its clamp recovery to the position written', () => {
    const virtualizer = liveVirtualizer()
    const lib = virtualizer as unknown as {
      pendingWrite: { target: number } | null
      _clampedAdjustment: unknown
      _clampedBy: (target: number) => unknown
    }
    lib.pendingWrite = { target: 10 }
    const clampedBy = vi.spyOn(lib, '_clampedBy')
    retargetLibraryWrite(virtualizer, 300, 20)
    expect(lib.pendingWrite).toEqual({ target: 320 })
    expect(clampedBy).toHaveBeenCalledWith(320)
  })

  it('leaves a library without those names untouched', () => {
    const bare = {}
    expect(libraryCommand(bare)).toBeNull()
    expect(heldOffset(bare)).toBe(0)
    expect(canWriteScroll(bare)).toBe(true)
    expect(awaitingCommandReadBack(bare)).toBe(false)
    expect(hasPendingFling(bare)).toBe(false)
    expect(hasLibraryAdjustment(bare)).toBe(false)
    expect(applyLibraryAdjustment(bare, 5)).toBe(false)
    expect(() => retargetLibraryWrite(bare, 1, 1)).not.toThrow()
    expect(() => trackCommitUpdate(bare, () => {})).not.toThrow()
  })
})
