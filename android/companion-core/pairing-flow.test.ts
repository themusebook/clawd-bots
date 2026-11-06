/**
 * Pairing flow + session tests: the state machine the pairing screen
 * renders, and the storage contract the token depends on.
 */

import { describe, expect, it } from 'vitest'

import { PairingFlow, transportNote } from './pairing-flow'
import { parseConnection } from './connection'
import type { FetchFn, FetchResponseLike } from './pairing'
import { MemorySessionStore, parseSession, serializeSession, type PairedSession } from './session'

const TOKEN = `omb_pair_${'A'.repeat(43)}`

function jsonResponse(status: number, body: unknown): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function makeFetch(behavior: { healthy: boolean; pairStatus?: number }) {
  const bodies: Record<string, unknown>[] = []
  const fn: FetchFn = async (url, init) => {
    if (url.endsWith('/api/health')) {
      if (!behavior.healthy) throw new Error('unreachable')
      return jsonResponse(200, { app: 'clawdbot' })
    }
    const record = init as { body?: string }
    if (record.body) bodies.push(JSON.parse(record.body) as Record<string, unknown>)
    if (behavior.pairStatus && behavior.pairStatus >= 300) {
      return jsonResponse(behavior.pairStatus, { error: 'That pairing code has expired.' })
    }
    return jsonResponse(200, {
      token: 'omb_dev_testtoken',
      device: { id: 'dev-1', name: 'Seeker', createdAt: 1, lastSeenAt: 1 },
      serverName: "Ada's computer",
    })
  }
  return { fn, bodies }
}

function link(params: Record<string, string>): string {
  return `clawdbot://pair?${new URLSearchParams(params).toString()}`
}

describe('PairingFlow', () => {
  it('a scanned link reaches review with the right consent origin and transport note', () => {
    const flow = new PairingFlow({ store: new MemorySessionStore(), deviceName: 'Seeker' })
    expect(flow.acceptInviteLink(link({ address: 'ada.ts.net:8810', token: TOKEN }))).toBe(true)
    expect(flow.phase.kind).toBe('review')
    if (flow.phase.kind === 'review') {
      expect(flow.phase.consentOrigin).toBe('http://ada.ts.net:8810')
      expect(flow.phase.transportNote).toContain('WireGuard')
    }
  })

  it('a LAN review warns about cleartext', () => {
    const flow = new PairingFlow({ store: new MemorySessionStore(), deviceName: 'Seeker' })
    expect(flow.acceptManual('192.168.1.20', '123456')).toBe(true)
    if (flow.phase.kind === 'review') expect(flow.phase.transportNote).toContain('Cleartext')
  })

  it('bad input fails with a specific message and no retry', () => {
    const flow = new PairingFlow({ store: new MemorySessionStore(), deviceName: 'Seeker' })
    expect(flow.acceptInviteLink('clawdbot://pair?address=ada.ts.net')).toBe(false)
    expect(flow.phase.kind).toBe('failed')
    if (flow.phase.kind === 'failed') expect(flow.phase.canRetry).toBe(false)
    expect(flow.acceptManual('not an address!', '123456')).toBe(false)
    expect(flow.acceptManual('ada.ts.net', 'nope')).toBe(false)
  })

  it('confirming a healthy route pairs, persists, and relaunch restores with no new code', async () => {
    const store = new MemorySessionStore()
    const { fn, bodies } = makeFetch({ healthy: true })
    const flow = new PairingFlow({ store, deviceName: 'Seeker', fetchFn: fn, now: () => 42 })
    flow.acceptInviteLink(link({ address: 'ada.ts.net:8810', token: TOKEN }))
    await flow.confirmPair()
    expect(flow.phase.kind).toBe('paired')
    if (flow.phase.kind === 'paired') {
      expect(flow.phase.session.token).toBe('omb_dev_testtoken')
      expect(flow.phase.session.pairedAt).toBe(42)
    }
    expect(bodies[0]?.['deviceName']).toBe('Seeker')

    const relaunched = new PairingFlow({ store, deviceName: 'Seeker' })
    expect(await relaunched.restore()).toBe(true)
    expect(relaunched.phase.kind).toBe('paired')
  })

  it('an unreachable computer fails retryable and the retry reuses the request id', async () => {
    const behavior = { healthy: false }
    const { fn, bodies } = makeFetch(behavior)
    const flow = new PairingFlow({ store: new MemorySessionStore(), deviceName: 'Seeker', fetchFn: fn })
    flow.acceptInviteLink(link({ address: 'ada.ts.net:8810', token: TOKEN }))
    await flow.confirmPair()
    expect(flow.phase.kind).toBe('failed')
    if (flow.phase.kind === 'failed') expect(flow.phase.canRetry).toBe(true)

    behavior.healthy = true
    await flow.confirmPair()
    expect(flow.phase.kind).toBe('paired')
    // Only the successful retry posts a body — and every attempt carries a request id.
    expect(bodies).toHaveLength(1)
    expect(typeof bodies[0]?.['pairRequestId']).toBe('string')
  })

  it('a rejection is final for that credential (no retry offered)', async () => {
    const { fn } = makeFetch({ healthy: true, pairStatus: 401 })
    const flow = new PairingFlow({ store: new MemorySessionStore(), deviceName: 'Seeker', fetchFn: fn })
    flow.acceptInviteLink(link({ address: 'ada.ts.net:8810', token: TOKEN }))
    await flow.confirmPair()
    expect(flow.phase.kind).toBe('failed')
    if (flow.phase.kind === 'failed') {
      expect(flow.phase.canRetry).toBe(false)
      expect(flow.phase.message).toBe('That pairing code has expired.')
    }
  })

  it('unpair clears the stored session', async () => {
    const store = new MemorySessionStore()
    const { fn } = makeFetch({ healthy: true })
    const flow = new PairingFlow({ store, deviceName: 'Seeker', fetchFn: fn })
    flow.acceptInviteLink(link({ address: 'ada.ts.net:8810', token: TOKEN }))
    await flow.confirmPair()
    await flow.unpair()
    expect(flow.phase.kind).toBe('methods')
    expect(await store.load()).toBeNull()
  })
})

describe('session serialization', () => {
  const session: PairedSession = {
    connection: parseConnection('ada.ts.net:8810')!,
    token: 'omb_dev_testtoken',
    pairedAt: 42,
  }

  it('round-trips through JSON', () => {
    expect(parseSession(serializeSession(session))).toEqual(session)
  })

  it('corrupt or partial data reads as not paired', () => {
    expect(parseSession(null)).toBeNull()
    expect(parseSession('{not json')).toBeNull()
    expect(parseSession('{"token":""}')).toBeNull()
    expect(parseSession('{"token":"x","pairedAt":1}')).toBeNull()
    expect(parseSession('{"token":"x","pairedAt":1,"connection":{"host":5}}')).toBeNull()
  })
})

describe('transportNote', () => {
  it('names the transport honestly per route kind', () => {
    expect(transportNote(parseConnection('https://companion.example.com')!)).toContain('HTTPS')
    expect(transportNote(parseConnection('ada.ts.net')!)).toContain('WireGuard')
    expect(transportNote(parseConnection('192.168.1.20')!)).toContain('Cleartext')
  })
})
