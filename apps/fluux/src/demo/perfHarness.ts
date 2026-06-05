import type { StressScenario } from '@fluux/sdk'

/** Parse `?stress=rooms:15,messages:150,occupants:80,mode:backfill` into a scenario. */
export function parseStressParam(params: URLSearchParams): StressScenario | null {
  const raw = params.get('stress')
  if (raw === null) return null
  const scenario: StressScenario = { kind: 'room-join' }
  for (const part of raw.split(',')) {
    const [key, value] = part.split(':')
    if (!key || value === undefined) continue
    const n = Number(value)
    switch (key.trim()) {
      case 'rooms': if (Number.isFinite(n)) scenario.rooms = n; break
      case 'messages': if (Number.isFinite(n)) scenario.messagesPerRoom = n; break
      case 'occupants': if (Number.isFinite(n)) scenario.occupants = n; break
      case 'mode': if (value === 'backfill' || value === 'live') scenario.mode = value; break
    }
  }
  return scenario
}
