import { describe, expect, it } from 'vitest'

import { activitySignature, deriveActivities, planNotificationSync } from './activity'
import type { Bot, Group, Message } from './models'
import type { CompanionState } from './store'

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    threadId: 'thread-1',
    name: 'Pesto',
    title: 'Helper',
    description: '',
    notifications: true,
    color: 'green',
    unread: false,
    modelSelection: { instanceId: 'i1', model: 'claude' },
    createdAt: 1000,
    tasks: [],
    ...overrides,
  }
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    role: 'bot',
    kind: 'text',
    at: 2000,
    parentId: null,
    text: 'hello',
    ...overrides,
  }
}

function makeState(bots: Bot[], groups: Group[], messagesByThread: Record<string, Message[]>): CompanionState {
  return { bots, groups, messagesByThread, cursor: null, resumed: true, hydrated: true }
}

function stateWith(b: Bot, messages: Message[]): CompanionState {
  return makeState([b], [], { [b.threadId]: messages })
}

describe('deriveActivities', () => {
  it('a pending card makes needsYou, carrying the request and options', () => {
    const card = { title: 'Run rm?', options: ['Approve', 'Deny'], requestId: 'r1', tool: 'bash' }
    const activities = deriveActivities(stateWith(bot({ busy: true, unread: true }), [message({ card })]))
    expect(activities).toHaveLength(1)
    expect(activities[0].state.kind).toBe('needsYou')
    expect(activities[0].state.headline).toBe('Pesto needs you')
    expect(activities[0].state.requestId).toBe('r1')
    expect(activities[0].state.isPermission).toBe(true)
    expect(activities[0].state.since).toBe(2000)
    // The face is forBot's verdict, independent of the activity kind: this
    // bot is busy, so it wears "working" even while it waits on you.
    expect(activities[0].state.face).toBe('working')
    expect(activities[0].state.line).toBe('Run rm?')
  })

  it('busy without a pending card is working; unread finished work is toReview; quiet is nothing', () => {
    expect(deriveActivities(stateWith(bot({ busy: true }), [message()]))[0].state.kind).toBe('working')
    expect(deriveActivities(stateWith(bot({ unread: true }), [message()]))[0].state.kind).toBe('toReview')
    expect(deriveActivities(stateWith(bot(), [message()]))).toHaveLength(0)
  })

  it('an answered card is not pending — the bot falls through to busy/unread', () => {
    const card = { title: 'Run rm?', options: ['Approve'], requestId: 'r1', answered: 'Approve' }
    const activities = deriveActivities(stateWith(bot({ busy: true }), [message({ card })]))
    expect(activities[0].state.kind).toBe('working')
  })

  it('notifications off and hidden bots never appear; rooms never appear', () => {
    const card = { title: 'Q?', options: ['A'], requestId: 'r1' }
    expect(deriveActivities(stateWith(bot({ notifications: false }), [message({ card })]))).toHaveLength(0)
    expect(deriveActivities(stateWith(bot({ hidden: true }), [message({ card })]))).toHaveLength(0)
    const room: Group = {
      id: 'g1',
      threadId: 'gt',
      name: 'Room',
      memberIds: [],
      defaultResponder: { kind: 'bot' },
      bulletin: '',
      unread: true,
      createdAt: 1,
      busyBotId: null,
    }
    const roomState = makeState([], [room], { gt: [message({ card })] })
    expect(deriveActivities(roomState)).toHaveLength(0)
  })

  it('orders needsYou before working before toReview', () => {
    const needy = bot({ id: 'b1', threadId: 't1', name: 'Needy' })
    const worker = bot({ id: 'b2', threadId: 't2', name: 'Worker', busy: true })
    const reviewer = bot({ id: 'b3', threadId: 't3', name: 'Reviewer', unread: true })
    const state = makeState([reviewer, worker, needy], [], {
      t1: [message({ card: { title: 'Q?', options: ['A'], requestId: 'r1' } })],
      t2: [message()],
      t3: [message()],
    })
    expect(deriveActivities(state).map((a) => a.state.kind)).toEqual(['needsYou', 'working', 'toReview'])
  })
})

describe('planNotificationSync', () => {
  it('presents new and changed activities, dismisses vanished ones, skips unchanged', () => {
    const a1 = deriveActivities(stateWith(bot({ busy: true }), [message()]))[0]
    const presented = new Map<string, string>([
      ['bot-1', activitySignature(a1)],
      ['ghost', 'working||x|y|'],
    ])
    const plan = planNotificationSync([a1], presented)
    expect(plan.present).toHaveLength(0)
    expect(plan.dismissBotIds).toEqual(['ghost'])

    const a2 = deriveActivities(stateWith(bot({ busy: true }), [message({ text: 'different work' })]))[0]
    const changed = planNotificationSync([a2], presented)
    expect(changed.present).toHaveLength(1)

    const empty = planNotificationSync([], new Map())
    expect(empty.present).toHaveLength(0)
    expect(empty.dismissBotIds).toHaveLength(0)
  })
})
