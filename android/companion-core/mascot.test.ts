import { describe, expect, it } from 'vitest'

import {
  FACE_VIEWBOX,
  clawdStateForBot,
  faceGeometry,
  gradientStops,
  mixHex,
  normalizeClawdState,
  paletteColor,
  restingExpression,
  ringPoints,
  showsActivity,
} from './mascot'
import { EXPRESSIONS_FLAT, GAZE_FLAT, MOUTHS_FLAT, POOLS, SILHOUETTE_FACEBOX_PATH } from './mascot-data'
import type { Bot, Message } from './models'

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'b1',
    threadId: 't1',
    name: 'Pesto',
    title: 'Helper',
    description: '',
    notifications: true,
    color: 'green',
    unread: false,
    modelSelection: { instanceId: 'i1', model: 'claude' },
    createdAt: 1,
    tasks: [],
    ...overrides,
  }
}

function message(overrides: Partial<Message> = {}): Message {
  return { id: 'm1', role: 'bot', kind: 'text', at: 1, parentId: null, text: 'hi', ...overrides }
}

describe('generated tables', () => {
  it('carry the desktop numbers at the desktop shapes', () => {
    expect(EXPRESSIONS_FLAT).toHaveLength(25 * 2 * 48 * 2)
    expect(GAZE_FLAT).toHaveLength(50)
    expect(MOUTHS_FLAT).toHaveLength(100)
    expect(POOLS['idle']).toEqual([6, 0, 8])
    expect(POOLS['working']).toEqual([10, 7, 16, 11])
    expect(SILHOUETTE_FACEBOX_PATH.startsWith('M')).toBe(true)
    expect(FACE_VIEWBOX).toBe('-15 -15 258.541 258.541')
  })

  it('ring points read straight out of the flat table', () => {
    const ring = ringPoints(0, 0)
    expect(ring).toHaveLength(48)
    expect(ring[0]).toEqual({ x: EXPRESSIONS_FLAT[0], y: EXPRESSIONS_FLAT[1] })
    const eye1 = ringPoints(0, 1)
    expect(eye1[0]).toEqual({ x: EXPRESSIONS_FLAT[96], y: EXPRESSIONS_FLAT[97] })
  })
})

describe('palette', () => {
  it('matches CLAWD_COLORS, with the grey fallback', () => {
    expect(paletteColor('green')).toBe('#009957')
    expect(paletteColor('purple')).toBe('#8057C8')
    expect(paletteColor('chartreuse')).toBe('#8E8E93')
  })

  it('gradient stops lighten, hold, darken', () => {
    expect(mixHex('#000000', '#FFFFFF', 0.55)).toBe('#8c8c8c')
    expect(mixHex('#FFFFFF', '#000000', 0.42)).toBe('#949494')
    const [light, base, dark] = gradientStops('green')
    expect(base).toBe('#009957')
    expect(light).not.toBe(base)
    expect(dark).not.toBe(base)
  })
})

describe('clawdStateForBot', () => {
  it('a pinned expression wins, legacy names included', () => {
    expect(clawdStateForBot(bot({ mascotExpression: 'proud' }), undefined)).toBe('proud')
    expect(clawdStateForBot(bot({ mascotExpression: 'focused', busy: true }), undefined)).toBe('working')
    expect(clawdStateForBot(bot({ mascotExpression: 'deadpan' }), undefined)).toBe('idle')
    expect(clawdStateForBot(bot({ mascotExpression: 'junk' }), undefined)).toBe('idle')
  })

  it('then what the bot is doing: failure, busy, unread, waiting on an answer', () => {
    const failed = message({ kind: 'activity', tool: { name: 'bash', ok: false } })
    expect(clawdStateForBot(bot({ busy: true }), failed)).toBe('alerting')
    expect(clawdStateForBot(bot({ busy: true }), undefined)).toBe('working')
    expect(clawdStateForBot(bot({ unread: true }), undefined)).toBe('notifying')
    expect(clawdStateForBot(bot(), message({ kind: 'options' }))).toBe('curious')
  })

  it('then a guess from its role, whole words only', () => {
    expect(clawdStateForBot(bot({ title: 'Researcher' }), undefined)).toBe('searching')
    expect(clawdStateForBot(bot({ name: 'Forge', title: 'Code reviewer' }), undefined)).toBe('working')
    expect(clawdStateForBot(bot({ title: 'Night watch' }), undefined)).toBe('drowsy')
    expect(clawdStateForBot(bot({ title: 'QA lead' }), undefined)).toBe('suspicious')
    expect(clawdStateForBot(bot({ title: 'Concierge' }), undefined)).toBe('idle')
    // "art" inside "start" must not match — word boundaries, like the Swift regex.
    expect(clawdStateForBot(bot({ title: 'Start manager' }), undefined)).toBe('idle')
  })

  it('showsActivity is the four turn-in-progress states', () => {
    expect(showsActivity('working')).toBe(true)
    expect(showsActivity('thinking')).toBe(true)
    expect(showsActivity('idle')).toBe(false)
    expect(showsActivity('notifying')).toBe(false)
  })
})

describe('normalizeClawdState', () => {
  it('current names pass, legacy resolves, junk is null', () => {
    expect(normalizeClawdState('thinking-dots')).toBe('thinking-dots')
    expect(normalizeClawdState('sleepy')).toBe('drowsy')
    expect(normalizeClawdState('nope')).toBeNull()
    expect(normalizeClawdState('')).toBeNull()
    expect(normalizeClawdState(undefined)).toBeNull()
  })
})

describe('faceGeometry', () => {
  it('the resting face is the pool first expression, fully formed', () => {
    expect(restingExpression('idle')).toBe(6)
    expect(restingExpression('working')).toBe(10)
    const geometry = faceGeometry('idle')
    expect(geometry.expression).toBe(6)
    for (const polygon of geometry.ringPolygons) {
      expect(polygon.split(' ')).toHaveLength(48)
    }
    expect(geometry.mouthD.startsWith('M ')).toBe(true)
    expect(geometry.mouthD).toContain(' Q ')
    // The eyes live in the face box, around its centre — a wrong table
    // offset would throw them hundreds of units away.
    for (const polygon of geometry.ringPolygons) {
      for (const pair of polygon.split(' ')) {
        const [x, y] = pair.split(',').map(Number)
        expect(x).toBeGreaterThan(-50)
        expect(x).toBeLessThan(300)
        expect(y).toBeGreaterThan(-50)
        expect(y).toBeLessThan(300)
      }
    }
    // Deterministic: a still is a still.
    expect(faceGeometry('idle')).toEqual(geometry)
    expect(faceGeometry('working').expression).toBe(10)
  })
})
