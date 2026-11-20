import { describe, it, expect } from 'vitest'
import { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'

type ObservedArchives = {
  observeArchive(key: string, isCurrent: () => boolean): void
  observedArchives: Map<string, () => boolean>
}

describe('MAM observed archives', () => {
  it('drops entries recorded by an ended session when a new one is recorded', () => {
    const mam = new MAM({} as ModuleDependencies) as unknown as ObservedArchives
    let firstSessionCurrent = true
    mam.observeArchive('["chat","a@example.org"]', () => firstSessionCurrent)
    mam.observeArchive('["room","r@conference.example.org"]', () => firstSessionCurrent)

    firstSessionCurrent = false
    mam.observeArchive('["chat","b@example.org"]', () => true)

    expect([...mam.observedArchives.keys()]).toEqual(['["chat","b@example.org"]'])
  })
})
