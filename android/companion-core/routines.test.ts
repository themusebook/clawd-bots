import { describe, expect, it } from 'vitest'

import type { Instance, Routine } from './models'
import { canSelectLocation, canToggleRoutine, runAvailability, scheduleSummary } from './routines'

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'r1',
    name: 'Morning post',
    prompt: 'Write the post',
    botId: 'b1',
    runOn: 'clawd',
    enabled: true,
    schedule: { type: 'daily', time: '09:00', weekdays: [1, 3, 5] },
    durationMinutes: 30,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('canToggleRoutine (the desktop canToggleRoutine policy)', () => {
  it('daily always; once only while ahead; unknown never', () => {
    const now = 1_000_000
    expect(canToggleRoutine(routine(), now)).toBe(true)
    expect(canToggleRoutine(routine({ schedule: { type: 'once', at: now + 1 } }), now)).toBe(true)
    expect(canToggleRoutine(routine({ schedule: { type: 'once', at: now - 1 } }), now)).toBe(false)
    expect(canToggleRoutine(routine({ schedule: { type: 'once' } }), now)).toBe(false)
    expect(canToggleRoutine(routine({ schedule: { type: 'weekly' } }), now)).toBe(false)
  })
})

describe('scheduleSummary', () => {
  it('renders each kind readably', () => {
    expect(scheduleSummary(routine())).toBe('Daily · 09:00 · Mon Wed Fri')
    expect(scheduleSummary(routine({ schedule: { type: 'weekly' } }))).toBe('Scheduled (newer format)')
    expect(scheduleSummary(routine({ schedule: { type: 'once', at: 1000 } }))).toContain('Once ·')
  })
})

describe('runAvailability', () => {
  const boxInstance = (state: string): Instance => ({
    instanceId: 'box-1',
    driverKind: 'boxAgent',
    snapshot: { state },
    models: { default: '', options: [] },
  })

  it('cloud is ready only with Box configured AND an available boxAgent instance', () => {
    expect(runAvailability({ box: { configured: true } }, [boxInstance('available')]).cloudReady).toBe(true)
    expect(runAvailability({ box: { configured: true } }, [boxInstance('unavailable')]).cloudReady).toBe(false)
    expect(runAvailability({ box: { configured: false } }, [boxInstance('available')]).cloudReady).toBe(false)
    expect(runAvailability(null, []).cloudReady).toBe(false)
  })

  it('clawd is always selectable; cloud needs readiness unless it is the current home', () => {
    const notReady = runAvailability(null, [])
    expect(canSelectLocation(notReady, 'clawd', 'clawd')).toBe(true)
    expect(canSelectLocation(notReady, 'cloud', 'clawd')).toBe(false)
    expect(canSelectLocation(notReady, 'cloud', 'cloud')).toBe(true)
  })
})
