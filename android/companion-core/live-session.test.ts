/**
 * Live session tests: hydrate → stream → fold, resume rules, revocation,
 * and the action verbs' routing — with a scripted transport and a recording
 * fetch, against the real captured fixtures where they fit.
 */

import { describe, expect, it } from 'vitest'

import botsFull from './fixtures/bots-full.json'
import { CompanionClient } from './client'
import { parseConnection } from './connection'
import { LiveSession, reconnectDelayMs, type StreamTransport } from './live-session'
import type { BotsResponse } from './models'
import { CompanionApiError, type FetchFn, type FetchResponseLike } from './pairing'

const Pesto = (botsFull as BotsResponse).bots[0]

function jsonResponse(status: number, body: unknown): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

interface Call {
  url: string
  body?: Record<string, unknown>
}

function makeClient(handler: (url: string, body?: Record<string, unknown>) => FetchResponseLike) {
  const calls: Call[] = []
  const fetchFn: FetchFn = async (url, init) => {
    const record = init as { body?: string }
    const body = record.body ? (JSON.parse(record.body) as Record<string, unknown>) : undefined
    calls.push({ url, body })
    return handler(url, body)
  }
  const client = new CompanionClient(parseConnection('ada.ts.net:8810')!, 'omb_dev_testtoken', fetchFn)
  return { client, calls }
}

function sse(frames: object[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
}

function scriptedTransport(script: (string | Error)[]): StreamTransport & { urls: string[] } {
  const urls: string[] = []
  let index = 0
  return {
    urls,
    open(url: string) {
      urls.push(url)
      const step = script[Math.min(index++, script.length - 1)]
      return {
        async *[Symbol.asyncIterator]() {
          if (step instanceof Error) throw step
          yield step
        },
      }
    },
  }
}

// A macrotask sleep: an instantly-failing transport plus a microtask sleep
// would spin the reconnect loop forever and starve the test's own timers.
const noSleep = () => new Promise<void>((resolve) => setTimeout(resolve, 1))

describe('client verbs (Client.swift routes)', () => {
  it('hits the exact routes with the exact bodies', async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, {}))
    await client.sendToBot('bot-1', 'hello')
    await client.sendToRoom('room-1', 'hi room')
    await client.respondToThread('thread-1', 'req-1', 'allow')
    await client.respondToThread('thread-1', 'req-2', 'answer', 'Work & projects')
    await client.interruptBot('bot-1')
    await client.markBotRead('bot-1')
    await client.markRoomRead('room-1')
    expect(calls.map((call) => call.url.replace('http://ada.ts.net:8810', ''))).toEqual([
      '/api/bots/bot-1/messages',
      '/api/groups/room-1/messages',
      '/api/threads/thread-1/respond',
      '/api/threads/thread-1/respond',
      '/api/bots/bot-1/interrupt',
      '/api/bots/bot-1/read',
      '/api/groups/room-1/read',
    ])
    expect(calls[0].body).toEqual({ text: 'hello' })
    expect(calls[2].body).toEqual({ requestId: 'req-1', behavior: 'allow' })
    expect(calls[3].body).toEqual({ requestId: 'req-2', behavior: 'answer', message: 'Work & projects' })
  })

  it('builds the events URL the way Client.swift does (screens=off, since=cursor)', () => {
    const { client } = makeClient(() => jsonResponse(200, {}))
    expect(client.eventsUrl(null)).toBe('http://ada.ts.net:8810/api/events?screens=off')
    expect(client.eventsUrl('s1:9')).toBe('http://ada.ts.net:8810/api/events?screens=off&since=s1%3A9')
    expect(client.streamHeaders).toEqual({ Accept: 'text/event-stream', Authorization: 'Bearer omb_dev_testtoken' })
  })
})

describe('answerCard always-allow', () => {
  it('"Always allow" grants with the card key before it responds', async () => {
    const botId = '4f254cf4-98c5-45ca-907e-967e2bbcb8ac'
    const threadId = '1f3a20e3-94f2-432b-8af5-db9664ed74a2'
    const newBot = {
      id: botId,
      threadId,
      name: 'Pesto',
      title: '',
      description: '',
      notifications: true,
      color: 'green',
      unread: false,
      modelSelection: { instanceId: 'i1', model: 'claude' },
      createdAt: 1,
      tasks: [],
    }
    const { client, calls } = makeClient((url) =>
      url.endsWith('/api/bots') ? jsonResponse(200, { bot: newBot }) : jsonResponse(200, {}),
    )
    const session = new LiveSession({ client, transport: scriptedTransport([]), sleep: noSleep })
    // Fold a bot in so the thread resolves to it (createBot folds, like iOS).
    await session.createBot()
    calls.length = 0
    const card = {
      title: 'Run bash?',
      options: ['Allow', 'Always allow', 'Deny'],
      requestId: 'r9',
      tool: 'bash',
      allowKey: 'tool:bash',
    }
    await session.answerCard(threadId, { messageId: 'm9', card }, 'Always allow')
    const paths = calls.map((call) => call.url)
    expect(paths.some((url) => url.endsWith(`/api/bots/${botId}/always-allow`))).toBe(true)
    expect(paths.some((url) => url.endsWith(`/api/threads/${threadId}/respond`))).toBe(true)
    const grantIndex = paths.findIndex((url) => url.includes('always-allow'))
    const respondIndex = paths.findIndex((url) => url.includes('respond'))
    expect(grantIndex).toBeLessThan(respondIndex)
    expect(calls[grantIndex].body).toEqual({ allowKey: 'tool:bash' })
    expect(calls[respondIndex].body).toEqual({ requestId: 'r9', behavior: 'allow' })
    await session.answerByRequest(threadId, 'missing', 'Allow').then((answered) => expect(answered).toBe(false))
  })
})

describe('LiveSession', () => {
  function harness(script: (string | Error)[], botsResponse: unknown = botsFull) {
    const botsCalls: Call[] = []
    const { client, calls } = makeClient((url) => {
      if (url.endsWith('/api/bots?messages=50')) {
        botsCalls.push({ url })
        return jsonResponse(200, botsResponse)
      }
      return jsonResponse(200, {})
    })
    const transport = scriptedTransport(script)
    const session = new LiveSession({ client, transport, sleep: noSleep })
    return { session, transport, calls, botsCalls }
  }

  it('hydrates, goes live on hello, and folds streamed messages', async () => {
    const hello = { kind: 'hello', cursor: 's1:0', resumed: true }
    const message = {
      kind: 'message',
      threadId: Pesto.threadId,
      seq: 1,
      message: { id: 'm-new', at: 9, parentId: null, role: 'bot', kind: 'text', text: 'fresh off the stream' },
    }
    const { session } = harness([sse([hello, message]), new Error('dropped')])
    const running = session.start()
    // Let the first stream + one failed reconnect cycle run, then stop.
    await new Promise((resolve) => setTimeout(resolve, 25))
    session.stop()
    await running.catch(() => {})
    expect(session.status).toBe('stopped')
    expect(session.state.hydrated).toBe(true)
    expect(session.threadMessages(Pesto.threadId).some((m) => m.id === 'm-new')).toBe(true)
    expect(session.state.cursor).toBe('s1:1')
    expect(session.roster()).toHaveLength(1)
    expect(session.roster()[0].name).toBe('Pesto')
  })

  it('a hello with resumed:false re-hydrates instead of trusting a gap', async () => {
    const { session, botsCalls } = harness([sse([{ kind: 'hello', cursor: 's2:0', resumed: false }]), new Error('x')])
    const running = session.start()
    await new Promise((resolve) => setTimeout(resolve, 25))
    session.stop()
    await running.catch(() => {})
    expect(botsCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('a 401 from the stream means revoked — no retry loop', async () => {
    const { client } = makeClient((url) =>
      url.includes('/api/bots') ? jsonResponse(200, botsFull) : jsonResponse(200, {}),
    )
    const transport: StreamTransport = {
      open() {
        return {
          async *[Symbol.asyncIterator]() {
            throw new CompanionApiError(401, undefined)
          },
        }
      },
    }
    const session = new LiveSession({ client, transport, sleep: noSleep })
    await session.start()
    expect(session.status).toBe('revoked')
    expect(session.lastError).toContain('no longer paired')
  })

  it('resumes the next stream from the fold cursor', async () => {
    const hello = { kind: 'hello', cursor: 's1:0', resumed: true }
    const message = {
      kind: 'message',
      threadId: Pesto.threadId,
      seq: 7,
      message: { id: 'm-7', at: 10, parentId: null, role: 'user', kind: 'text', text: 'seven' },
    }
    const { session, transport } = harness([sse([hello, message]), new Error('drop'), new Error('drop again')])
    const running = session.start()
    await new Promise((resolve) => setTimeout(resolve, 25))
    session.stop()
    await running.catch(() => {})
    expect(transport.urls.length).toBeGreaterThanOrEqual(2)
    expect(transport.urls[1]).toContain('since=s1%3A7')
  })

  it('answers cards with wire behaviors, not button text', async () => {
    const { session, calls } = harness([sse([{ kind: 'hello', cursor: 's1:0', resumed: true }]), new Error('x')])
    const running = session.start()
    await new Promise((resolve) => setTimeout(resolve, 15))
    session.stop()
    await running.catch(() => {})

    const permission = {
      messageId: 'm1',
      card: { title: 'Run?', options: ['Approve', 'Deny'], requestId: 'r1', tool: 'Bash' },
    }
    await session.answerCard(Pesto.threadId, permission, 'Approve')
    await session.answerCard(Pesto.threadId, permission, 'Deny')
    const question = { messageId: 'm2', card: { title: 'Pick', options: ['A', 'B'], requestId: 'r2' } }
    await session.answerCard(Pesto.threadId, question, 'A')
    const responds = calls.filter((call) => call.url.endsWith('/respond')).map((call) => call.body)
    expect(responds).toEqual([
      { requestId: 'r1', behavior: 'allow' },
      { requestId: 'r1', behavior: 'deny' },
      { requestId: 'r2', behavior: 'answer', message: 'A' },
    ])
  })

  it('pendingCards only surfaces unanswered requests', async () => {
    const { session } = harness([sse([{ kind: 'hello', cursor: 's1:0', resumed: true }]), new Error('x')])
    const running = session.start()
    await new Promise((resolve) => setTimeout(resolve, 15))
    session.stop()
    await running.catch(() => {})
    // bots-full's last message is the fixture options card (no requestId) → historical, not pending.
    expect(session.pendingCards(Pesto.threadId)).toEqual([])
  })
})

describe('loadAround (search hit landing)', () => {
  const held = [
    { id: 'm10', role: 'bot', kind: 'text', at: 1000, parentId: null, text: 'ten' },
    { id: 'm11', role: 'bot', kind: 'text', at: 1100, parentId: null, text: 'eleven' },
  ]

  function seededSession(handler: (url: string) => FetchResponseLike) {
    const { client, calls } = makeClient((url) => handler(url))
    const session = new LiveSession({ client, transport: scriptedTransport([]), sleep: noSleep })
    session.state = {
      bots: [],
      groups: [],
      messagesByThread: { t1: [...held] },
      cursor: null,
      resumed: true,
      hydrated: true,
    }
    return { session, calls }
  }

  it('already-held messages land without a fetch', async () => {
    const { session, calls } = seededSession(() => jsonResponse(200, {}))
    await expect(session.loadAround('t1', 'm10')).resolves.toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('fetches the around page and merges deduped, in time order', async () => {
    const page = {
      messages: [
        { id: 'm8', role: 'user', kind: 'text', at: 800, parentId: null, text: 'eight' },
        { id: 'm9', role: 'bot', kind: 'text', at: 900, parentId: null, text: 'the lobster bit' },
        { id: 'm10', role: 'bot', kind: 'text', at: 1000, parentId: null, text: 'ten' },
      ],
      hasMore: true,
    }
    const { session, calls } = seededSession(() => jsonResponse(200, page))
    await expect(session.loadAround('t1', 'm9')).resolves.toBe(true)
    expect(calls[0].url).toContain('/api/threads/t1/messages?limit=50&around=m9')
    expect(session.threadMessages('t1').map((message) => message.id)).toEqual(['m8', 'm9', 'm10', 'm11'])
    // The page reached older ground, so scrollback stays available.
    expect(session.hasMore('t1')).toBe(true)
  })

  it('reports false when the page does not contain the message', async () => {
    const { session } = seededSession(() => jsonResponse(200, { messages: [], hasMore: false }))
    await expect(session.loadAround('t1', 'gone')).resolves.toBe(false)
  })

  it('search passes through to the client', async () => {
    const { client } = makeClient(() => jsonResponse(200, { hits: [{ threadId: 't1', messageId: 'm9' }] }))
    const session = new LiveSession({ client, transport: scriptedTransport([]), sleep: noSleep })
    expect(await session.search('lobster')).toHaveLength(1)
  })
})

describe('reconnectDelayMs', () => {
  it('doubles from 1s to a 30s ceiling', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
})
