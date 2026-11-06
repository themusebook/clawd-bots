import { EXPRESSIONS_FLAT, GAZE_FLAT, MOUTHS_FLAT, POOLS, CLAWD_STATES } from './mascot-data'
import type { Bot, Message } from './models'

/**
 * The mascot — port of iOS App/ClawdAvatar.swift (palette, still-face
 * geometry) + App/MascotState.swift (which face a bot wears) over the
 * generated tables in mascot-data.ts. Same numbers as the desktop, which is
 * the whole point.
 *
 * Scope: the RESTING face for a state (the pool's first expression, morph
 * complete — exactly what ClawdFaceStill draws). The animation engine
 * (spring morphs, blink rhythm, gaze wander, comets, body bob) is a separate
 * layer that belongs on the surfaces where motion carries meaning; lists
 * get stills, as they do on iOS unless a state shows activity.
 */

export type ClawdState = string

export const FACE_BOX = 228.541
export const FACE_MARGIN = 15
/** The desktop's viewBox: the face box with its 15-unit margin. */
export const FACE_VIEWBOX = '-15 -15 258.541 258.541'
export const FACE_CENTRE = { x: 120, y: 122.5 } as const
export const FACE_ANCHOR = { x: 87.04, y: 98.65, scale: 0.84 } as const
export const MOUTH_STROKE = 7.5
/** The desktop's lookAround default: how much of an expression's gaze to keep. */
export const LOOK_AROUND = 0.35
/** SVG transform for the face group, mirroring the Canvas anchor transform. */
export const FACE_TRANSFORM = `translate(${FACE_ANCHOR.x} ${FACE_ANCHOR.y}) scale(${FACE_ANCHOR.scale}) translate(${-FACE_CENTRE.x} ${-FACE_CENTRE.y})`

// MARK: - Palette (src/lib/mascot.ts — CLAWD_COLORS)

const PALETTE_HEX: Record<string, string> = {
  green: '#009957',
  blue: '#377FE6',
  red: '#D94B52',
  orange: '#E78531',
  purple: '#8057C8',
  cyan: '#0EA5C6',
  pink: '#D84F8B',
  yellow: '#D8A729',
  teal: '#01A492',
  coral: '#E5634E',
}

export function paletteColor(name: string): string {
  return PALETTE_HEX[name] ?? '#8E8E93'
}

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const part = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/** SwiftUI Color.mixed(with:amount:) — a straight sRGB lerp. */
export function mixHex(base: string, other: string, amount: number): string {
  const a = hexToRgb(base)
  const b = hexToRgb(other)
  return rgbToHex([a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount])
}

/** The body gradient: lightened top-right, base, darkened bottom-left. */
export function gradientStops(colorName: string): [string, string, string] {
  const base = paletteColor(colorName)
  return [mixHex(base, '#FFFFFF', 0.55), base, mixHex(base, '#000000', 0.42)]
}

// MARK: - State (App/MascotState.swift)

/** The desktop's legacy names, kept so an older bot record still resolves. */
const LEGACY_STATES: Record<string, string> = {
  deadpan: 'idle',
  friendly: 'happy',
  focused: 'working',
  thinking: 'thinking',
  excited: 'excited',
  sleepy: 'drowsy',
  surprised: 'surprised',
  skeptical: 'suspicious',
  worried: 'scared',
  mischievous: 'playful',
}

/** Resolves any stored value — current, legacy or junk — to a real state. */
export function normalizeClawdState(value: string | null | undefined): ClawdState | null {
  if (!value) return null
  if (CLAWD_STATES.includes(value)) return value
  return LEGACY_STATES[value] ?? null
}

/** States whose motion carries information — a turn in progress. */
const ACTIVITY_STATES = new Set(['listening', 'thinking', 'searching', 'working'])

export function showsActivity(state: ClawdState): boolean {
  return ACTIVITY_STATES.has(state)
}

const ROLE_RULES: [string[], ClawdState][] = [
  [
    ['code', 'coding', 'developer', 'development', 'engineer', 'engineering', 'build', 'debug', 'program', 'software'],
    'working',
  ],
  [
    ['research', 'researcher', 'search', 'investigate', 'strategy', 'strategist', 'study', 'learn', 'knowledge'],
    'searching',
  ],
  [['marketing', 'growth', 'launch', 'campaign', 'social', 'sales', 'outreach', 'brand'], 'excited'],
  [['overnight', 'night', 'background', 'async', 'queue', 'batch', 'long-running'], 'drowsy'],
  [['monitor', 'monitoring', 'incident', 'alert', 'watch', 'status', 'uptime'], 'radar'],
  [['review', 'reviewer', 'audit', 'critic', 'critique', 'quality', 'qa', 'test', 'legal'], 'suspicious'],
  [['security', 'secure', 'compliance', 'risk', 'privacy', 'finance', 'financial'], 'scared'],
  [['design', 'designer', 'creative', 'brainstorm', 'art', 'illustration', 'music', 'story'], 'playful'],
  [['support', 'help', 'success', 'onboarding', 'coach', 'teacher', 'guide', 'welcome'], 'happy'],
]

/**
 * Which face a bot wears — the desktop's stateForBot, in its exact order:
 * a pinned expression wins; then what the bot is doing right now; then a
 * guess from its role.
 */
export function clawdStateForBot(bot: Bot, last: Message | undefined): ClawdState {
  const pinned = normalizeClawdState(bot.mascotExpression)
  if (pinned) return pinned

  if (last?.kind === 'activity' && last.tool?.ok === false) return 'alerting'
  if (bot.busy === true) return 'working'
  if (bot.unread) return 'notifying'
  if (last?.kind === 'options') return 'curious'

  const profile = `${bot.name} ${bot.title} ${bot.description}`.toLowerCase()
  for (const [words, state] of ROLE_RULES) {
    if (words.some((word) => new RegExp(`\\b${word}\\b`).test(profile))) return state
  }
  return 'idle'
}

/** A room's face is "happy" — which is what the desktop draws for room avatars. */
export function clawdStateForRoom(): ClawdState {
  return 'happy'
}

export const ROOM_AVATAR_COLOR = 'blue'

// MARK: - Face geometry (the still: resting expression, morph complete)

export const EXPRESSION_COUNT = 25
export const POINTS_PER_RING = 48

/** The expression a resting face wears for a state: its pool's first. */
export function restingExpression(state: ClawdState): number {
  return POOLS[state]?.[0] ?? 0
}

export function ringPoints(expression: number, eye: 0 | 1): { x: number; y: number }[] {
  const base = (expression * 2 + eye) * POINTS_PER_RING * 2
  const points: { x: number; y: number }[] = []
  for (let i = 0; i < POINTS_PER_RING; i++) {
    points.push({ x: EXPRESSIONS_FLAT[base + i * 2], y: EXPRESSIONS_FLAT[base + i * 2 + 1] })
  }
  return points
}

export function gazePoint(expression: number): { x: number; y: number } {
  return { x: GAZE_FLAT[expression * 2], y: GAZE_FLAT[expression * 2 + 1] }
}

/** [halfWidth, curve, gap, skew] */
export function mouthSpec(expression: number): [number, number, number, number] {
  const base = expression * 4
  return [MOUTHS_FLAT[base], MOUTHS_FLAT[base + 1], MOUTHS_FLAT[base + 2], MOUTHS_FLAT[base + 3]]
}

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

export interface FaceGeometry {
  expression: number
  /** SVG `points` for the two eye rings, gaze already applied. */
  ringPolygons: [string, string]
  /** SVG path data for the mouth stroke. */
  mouthD: string
}

/**
 * The still face for a state, in face-centre coordinates (render inside
 * FACE_TRANSFORM). Mirrors ClawdFaceEngine.drawBody with morph = 1 and
 * blink = 1: rings offset by gaze × lookAround, mouth hung off the eyes —
 * centred under the pair, tilted with them, pushed clear of the taller eye.
 */
export function faceGeometry(state: ClawdState): FaceGeometry {
  const expression = restingExpression(state)
  const gaze = gazePoint(expression)
  const ox = gaze.x * LOOK_AROUND
  const oy = gaze.y * LOOK_AROUND
  const rings = ([0, 1] as const).map((eye) => ringPoints(expression, eye).map((p) => ({ x: p.x + ox, y: p.y + oy })))
  const ringPolygons = rings.map((ring) => ring.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')) as [string, string]

  const centre = (ring: { x: number; y: number }[]) => ({
    x: ring.reduce((sum, p) => sum + p.x, 0) / ring.length,
    y: ring.reduce((sum, p) => sum + p.y, 0) / ring.length,
  })
  const c0 = centre(rings[0])
  const c1 = centre(rings[1])
  const theta = Math.atan2(c1.y - c0.y, c1.x - c0.x)
  let halfHeight = 0
  for (const ring of rings) {
    const ys = ring.map((p) => p.y)
    halfHeight = Math.max(halfHeight, (Math.max(...ys) - Math.min(...ys)) / 2)
  }
  const spec = mouthSpec(expression)
  const drop = halfHeight + spec[2]
  const frame = {
    x: (c0.x + c1.x) / 2 - Math.sin(theta) * drop,
    y: (c0.y + c1.y) / 2 + Math.cos(theta) * drop,
    angle: theta + (spec[3] * Math.PI) / 180,
  }
  const ca = Math.cos(frame.angle)
  const sa = Math.sin(frame.angle)
  const at = (lx: number, ly: number) => ({ x: frame.x + lx * ca - ly * sa, y: frame.y + lx * sa + ly * ca })
  const start = at(-spec[0], 0)
  const control = at(0, spec[1])
  const end = at(spec[0], 0)
  const mouthD = `M ${fmt(start.x)} ${fmt(start.y)} Q ${fmt(control.x)} ${fmt(control.y)} ${fmt(end.x)} ${fmt(end.y)}`
  return { expression, ringPolygons, mouthD }
}
