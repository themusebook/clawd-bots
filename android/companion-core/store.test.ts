import { describe, expect, it } from 'vitest'
import { applyFrame, hydrate, initialState, updatesFor } from './store'
import botsFull from './fixtures/bots-full.json'
import botsPaged from './fixtures/bots-paged.json'
import sseFrames from './fixtures/sse-frames.json'
import threadPage from './fixtures/thread-page.json'
import type { BotsResponse, Frame } from './models'

describe('decoding the captured fixtures', () => {
  it('bots-full: one bot, no groups, an options card as the active leaf', () => {
    const response = botsFull as BotsResponse
    expect(response.bots).toHaveLength(1)
    expect(response.groups).toHaveLength(0)
    const bot = response.bots[0]
    expect(bot.name).toBe('Pesto')
    expect(bot.messages?.at(-1)?.kind).toBe('options')
    expect(bot.activeLeafId).toBe(bot.messages?.at(-1)?.id)
  })

  it('bots-paged: the group thread is paged (hasMore) and the bot thread is not', () => {
    const response = botsPaged as BotsResponse
    expect(response.groups).toHaveLength(1)
    expect(response.groups[0].hasMore).toBe(true)
    expect(response.bots[0].hasMore).toBe(false)
  })

  it('thread-page: two messages and more behind them', () => {
    expect(threadPage.messages).toHaveLength(2)
    expect(threadPage.hasMore).toBe(true)
    // Pages chain by parentId — message 5's parent is message 4.
    expect(threadPage.messages[1].parentId).toBe(threadPage.messages[0].id)
  })
})

describe('the fold', () => {
  it('hydrates the roster and folds each thread’s messages in', () => {
    const state = hydrate(initialState, botsFull as BotsResponse)
    expect(state.hydrated).toBe(true)
    expect(state.bots[0].name).toBe('Pesto')
    expect(state.messagesByThread[botsFull.bots[0].threadId]).toHaveLength(2)
  })

  it('replays the captured stream: hello sets the cursor, messages append in order, the bot frame flips unread', () => {
    let state = hydrate(initialState, botsFull as BotsResponse)
    for (const frame of sseFrames as Frame[]) state = applyFrame(state, frame)

    expect(state.cursor).toBe('f5696cc9:10')
    expect(state.resumed).toBe(false)

    const groupThread = '58c85a55-425d-4180-944f-d03f38f9bbbf'
    const texts = (state.messagesByThread[groupThread] ?? []).map((m) => m.text)
    expect(texts).toEqual([
      'fixture message 0',
      'fixture message 1',
      'fixture message 2',
      'fixture message 3',
      'fixture message 4',
      'fixture message 5',
    ])

    // The trailing bot frame carries unread:true — Pesto joins the Updates pill.
    expect(updatesFor(state).map((b) => b.name)).toEqual(['Pesto'])
  })

  it('never duplicates a message delivered twice (replay overlap)', () => {
    const frame = (sseFrames as Frame[])[1]
    let state = applyFrame(initialState, frame)
    state = applyFrame(state, frame)
    const threadId = (frame as { threadId: string }).threadId
    expect(state.messagesByThread[threadId]).toHaveLength(1)
  })
})
