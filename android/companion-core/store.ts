/**
 * The fold — port of iOS `Sources/CompanionCore/Store.swift`.
 *
 * Frames go in, settled state comes out. No optimistic state: actions call
 * the harness and let the stream deliver the result, so the phone never
 * draws its own version of what just happened.
 *
 * Scaffold scope: the fold handles the frame kinds the captured fixtures
 * prove (hello / message / bot) plus message.patch and runtime absorbed
 * minimally. Growing it means growing it against the iOS StoreTests.
 */

import type { Bot, BotsResponse, Frame, Group, Message } from './models'

export interface CompanionState {
  bots: Bot[]
  groups: Group[]
  messagesByThread: Record<string, Message[]>
  /** `<streamId>:<seq>` resume cursor from the hello frame / latest seq. */
  cursor: string | null
  /** False after a hello with resumed:false — the signal to hydrate. */
  resumed: boolean
  hydrated: boolean
}

export const initialState: CompanionState = {
  bots: [],
  groups: [],
  messagesByThread: {},
  cursor: null,
  resumed: false,
  hydrated: false,
}

export function hydrate(state: CompanionState, response: BotsResponse): CompanionState {
  const messagesByThread: Record<string, Message[]> = { ...state.messagesByThread }
  for (const bot of response.bots) {
    if (bot.messages) messagesByThread[bot.threadId] = bot.messages
  }
  for (const group of response.groups) {
    if (group.messages) messagesByThread[group.threadId] = group.messages
  }
  return { ...state, bots: response.bots, groups: response.groups, messagesByThread, hydrated: true }
}

export function applyFrame(state: CompanionState, frame: Frame): CompanionState {
  // Any sequenced frame advances the resume cursor, whichever kind it is.
  const seq = (frame as { seq?: number }).seq
  if (seq !== undefined && state.cursor) {
    state = { ...state, cursor: advanceCursor(state.cursor, seq) }
  }
  switch (frame.kind) {
    case 'hello': {
      const hello = frame as Extract<Frame, { kind: 'hello' }>
      return { ...state, cursor: hello.cursor, resumed: hello.resumed }
    }
    case 'message': {
      const { threadId, message, seq } = frame as Extract<Frame, { kind: 'message' }>
      const existing = state.messagesByThread[threadId] ?? []
      const next = existing.some((m) => m.id === message.id)
        ? existing.map((m) => (m.id === message.id ? message : m))
        : [...existing, message]
      return {
        ...state,
        messagesByThread: { ...state.messagesByThread, [threadId]: next },
        cursor: seq !== undefined && state.cursor ? advanceCursor(state.cursor, seq) : state.cursor,
      }
    }
    case 'bot': {
      const { bot } = frame as Extract<Frame, { kind: 'bot' }>
      const bots = state.bots.some((b) => b.id === bot.id)
        ? state.bots.map((b) => (b.id === bot.id ? { ...bot, messages: b.messages, activeLeafId: b.activeLeafId } : b))
        : [...state.bots, bot]
      return { ...state, bots }
    }
    default:
      // message.patch, runtime and unknown kinds: absorbed. The iOS fold
      // applies the small runtime delta subset needed to show a reply while
      // it is typed — port that from Store.swift with its tests.
      return state
  }
}

function advanceCursor(cursor: string, seq: number): string {
  const streamId = cursor.split(':')[0]
  return `${streamId}:${seq}`
}

/** The Updates pill rule, shared with BotActivity: only bots doing something. */
export function updatesFor(state: CompanionState): Bot[] {
  return state.bots.filter((bot) => bot.unread)
}
