/**
 * Pairing contract tests. These mirror the iOS `PairingTests.swift` suite —
 * same scenarios, same security claims — against the TypeScript port in
 * `pairing.ts` / `connection.ts` / `endpoint.ts`:
 *
 *  - a protected invite never probes or redeems on LAN/Bonjour routes;
 *  - a quick response never outranks the preferred protected route;
 *  - a transport failure retries a protected fallback with the SAME
 *    pairRequestId;
 *  - a hosted failure never falls back to cleartext HTTP;
 *  - when every probe fails the credential stays unspent;
 *  - a service that does not identify as Clawd Bot is rejected;
 *  - a pairing rejection is never sprayed at another route;
 *  - an explicit manual LAN connection still pairs.
 */

import { describe, expect, it } from 'vitest'

import { automaticEndpoints, establishRoutePolicyFromInvite, parseConnection, type Connection } from './connection'
import { createEndpoint, type CompanionEndpoint } from './endpoint'
import {
  CompanionApiError,
  PairingRouteError,
  pair,
  pairFirstReachable,
  parsePairingInvite,
  type FetchFn,
  type FetchResponseLike,
} from './pairing'

// MARK: - Helpers

const TOKEN = `omb_pair_${'A'.repeat(43)}` // 9 + 43 = 52 chars, the QR credential shape

function jsonResponse(status: number, body: unknown): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

const healthOK = () => jsonResponse(200, { app: 'clawdbot', version: 'test' })

const pairOK = (extra: Record<string, unknown> = {}) =>
  jsonResponse(200, {
    token: 'omb_dev_testtoken',
    device: { id: 'dev-1', name: 'Seeker', createdAt: 1, lastSeenAt: 1 },
    serverName: "Ada's computer",
    ...extra,
  })

interface RecordedCall {
  url: string
  method: string
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

function recorder(
  handler: (url: string, body?: Record<string, unknown>) => Promise<FetchResponseLike> | FetchResponseLike,
) {
  const calls: RecordedCall[] = []
  const fn: FetchFn = async (url, init) => {
    const record = init as { method?: string; body?: string; headers?: Record<string, string> }
    const body = typeof record.body === 'string' ? (JSON.parse(record.body) as Record<string, unknown>) : undefined
    calls.push({ url, method: String(record.method ?? 'GET'), body, headers: record.headers })
    return handler(url, body)
  }
  return { fn, calls }
}

function encodeEndpoints(endpoints: object[]): string {
  return Buffer.from(JSON.stringify(endpoints), 'utf8').toString('base64url')
}

function ep(url: string, kind: CompanionEndpoint['kind'], priority: number): CompanionEndpoint {
  const endpoint = createEndpoint(url, kind, priority)
  if (!endpoint) throw new Error(`bad test endpoint ${url}`)
  return endpoint
}

const tailnet = (priority = 0) => ep('http://ada.ts.net:8810', 'tailnet', priority)
const hosted = (priority = 0) => ep('https://companion.example.com', 'hosted', priority)
const lan = (priority = 0) => ep('http://192.168.1.20:8810', 'lan', priority)

function inviteUrl(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString()
  return `clawdbot://pair?${query}`
}

// MARK: - Invite parsing

describe('parsePairingInvite', () => {
  it('parses a token invite and binds policy to the tailnet route', () => {
    const invite = parsePairingInvite(inviteUrl({ address: 'ada.ts.net:8810', token: TOKEN, name: "Ada's computer" }))
    expect(invite).not.toBeNull()
    expect(invite!.credential).toBe(TOKEN)
    expect(invite!.connection.host).toBe('ada.ts.net')
    expect(invite!.connection.port).toBe(8810)
    expect(invite!.connection.name).toBe("Ada's computer")
    expect(invite!.connection.allowedRouteKinds).toEqual(expect.arrayContaining(['tailnet', 'hosted']))
    expect(invite!.connection.allowedLocalRouteUrls).toEqual([])
  })

  it('parses a legacy six-digit code invite', () => {
    const invite = parsePairingInvite(inviteUrl({ address: '192.168.1.20', code: '123456' }))
    expect(invite?.credential).toBe('123456')
    // A manually scanned LAN address is the user's explicit choice: exactly
    // that origin is consented, nothing else cleartext.
    expect(invite!.connection.allowedLocalRouteUrls).toEqual(['http://192.168.1.20:8810'])
  })

  it('rejects malformed credentials and shapes', () => {
    expect(parsePairingInvite(inviteUrl({ address: 'ada.ts.net', token: 'omb_pair_short' }))).toBeNull()
    expect(parsePairingInvite(inviteUrl({ address: 'ada.ts.net', token: 'nope' }))).toBeNull()
    expect(parsePairingInvite(inviteUrl({ address: 'ada.ts.net', code: '12345' }))).toBeNull()
    expect(parsePairingInvite(inviteUrl({ address: 'ada.ts.net', code: '12345a' }))).toBeNull()
    expect(parsePairingInvite('https://pair?address=ada.ts.net&code=123456')).toBeNull()
    expect(parsePairingInvite('clawdbot://pair?address=a.ts.net&address=b.ts.net&code=123456')).toBeNull()
    expect(parsePairingInvite(inviteUrl({ token: TOKEN }))).toBeNull()
  })

  it('typed endpoints win, are priority-sorted, and policy filters the rest', () => {
    const encoded = encodeEndpoints([
      { url: 'http://192.168.1.20:8810', kind: 'lan', priority: 2 },
      { url: 'http://ada.ts.net:8810', kind: 'tailnet', priority: 1 },
      { url: 'https://companion.example.com', kind: 'hosted', priority: 0 },
    ])
    const invite = parsePairingInvite(inviteUrl({ address: '192.168.1.20', token: TOKEN, endpoints: encoded }))
    expect(invite).not.toBeNull()
    // Hosted was selected by the invite → policy is hosted-only; the LAN and
    // tailnet advertisements do not survive as stored routes.
    expect(invite!.connection.activeEndpoint?.url).toBe('https://companion.example.com')
    expect(invite!.connection.allowedRouteKinds).toEqual(['hosted'])
    expect(invite!.connection.endpoints?.map((e) => e.url)).toEqual(['https://companion.example.com'])
  })

  it('a present-but-invalid endpoints value rejects the invite (no silent downgrade)', () => {
    const downgrade = encodeEndpoints([{ url: 'http://companion.example.com', kind: 'hosted', priority: 0 }])
    expect(parsePairingInvite(inviteUrl({ address: '192.168.1.20', token: TOKEN, endpoints: downgrade }))).toBeNull()
    expect(parsePairingInvite(inviteUrl({ address: '192.168.1.20', token: TOKEN, endpoints: '!!!' }))).toBeNull()
  })

  it('hosts list drops unusable candidates instead of failing the invite', () => {
    const invite = parsePairingInvite(
      inviteUrl({ address: 'ada.ts.net', code: '123456', hosts: 'ada.ts.net, bad/host, mac.local, other.ts.net' }),
    )
    // 'bad/host' is unparseable and dropped at parse; 'mac.local' parses but
    // is then removed by the route policy — the selected route is tailnet,
    // so a cleartext Bonjour host is not fresh consent (Swift:
    // advertisedHostsAllowedByRoutePolicy inside establishRoutePolicyFromInvite).
    expect(invite?.connection.hosts).toEqual(['ada.ts.net', 'other.ts.net'])
  })
})

// MARK: - Address + endpoint rules

describe('parseConnection / endpoint validation', () => {
  it('parses the manual-entry shapes', () => {
    expect(parseConnection('192.168.1.20')?.port).toBe(8810)
    expect(parseConnection('192.168.1.20:9000')?.port).toBe(9000)
    expect(parseConnection('[2001:db8::1]:8810')?.host).toBe('2001:db8::1')
    expect(parseConnection('2001:db8::1')?.port).toBe(8810)
    expect(parseConnection('bad host!')).toBeNull()
    expect(parseConnection('host:99999')).toBeNull()
    expect(parseConnection('')).toBeNull()
  })

  it('URL entry becomes a typed endpoint (https = hosted, ts.net http = tailnet)', () => {
    const secure = parseConnection('https://companion.example.com')
    expect(secure?.activeEndpoint?.kind).toBe('hosted')
    expect(secure?.port).toBe(443)
    expect(parseConnection('http://ada.ts.net:8810')?.activeEndpoint?.kind).toBe('tailnet')
    expect(parseConnection('http://mac.local:8810')?.activeEndpoint?.kind).toBe('bonjour')
  })

  it('endpoint kinds enforce their transport', () => {
    expect(createEndpoint('http://companion.example.com', 'hosted', 0)).toBeNull()
    expect(createEndpoint('http://example.com:8810', 'tailnet', 0)).toBeNull()
    expect(createEndpoint('https://ada.ts.net:8810', 'tailnet', 0)).toBeNull()
    expect(createEndpoint('https://192.168.1.20:8810', 'lan', 0)).toBeNull()
    expect(createEndpoint('http://user@ada.ts.net:8810', 'tailnet', 0)).toBeNull()
    expect(createEndpoint('http://ada.ts.net:8810/?x=1', 'tailnet', 0)).toBeNull()
    expect(tailnet().url).toBe('http://ada.ts.net:8810')
  })

  it('automaticCandidates ratchets: protected preferred drops cleartext; local preferred keeps only itself + protected', () => {
    expect(
      automaticEndpoints({ id: 'x', name: 'n', host: 'ada.ts.net', port: 8810, endpoints: [tailnet(0), lan(1)] }).map(
        (e) => e.kind,
      ),
    ).toEqual(['tailnet'])
    const localFirst = automaticEndpoints({
      id: 'x',
      name: 'n',
      host: '192.168.1.20',
      port: 8810,
      endpoints: [lan(0), ep('http://192.168.1.99:8810', 'lan', 1), tailnet(2)],
    })
    expect(localFirst.map((e) => e.url)).toEqual(['http://192.168.1.20:8810', 'http://ada.ts.net:8810'])
  })
})

// MARK: - The exchange

describe('pair', () => {
  it('sends the legacy field name for a six-digit code and no auth header', async () => {
    const { fn, calls } = recorder(() => pairOK())
    const connection = parseConnection('ada.ts.net:8810')!
    await pair(connection, '123456', 'Seeker', { fetchFn: fn, pairRequestId: 'req-1' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://ada.ts.net:8810/api/pair')
    expect(calls[0].body).toEqual({ code: '123456', deviceName: 'Seeker', pairRequestId: 'req-1' })
    expect(calls[0].headers?.['Authorization']).toBeUndefined()
  })

  it('sends `credential` for a QR token', async () => {
    const { fn, calls } = recorder(() => pairOK())
    await pair(parseConnection('ada.ts.net')!, TOKEN, 'Seeker', { fetchFn: fn })
    expect(calls[0].body?.['credential']).toBe(TOKEN)
    expect(calls[0].body?.['code']).toBeUndefined()
  })
})

describe('pairFirstReachable', () => {
  it('a protected invite never probes or redeems on LAN or Bonjour', async () => {
    const invite = parsePairingInvite(inviteUrl({ address: 'ada.ts.net:8810', token: TOKEN }))!
    const withRoutes: Connection = {
      ...invite.connection,
      endpoints: [tailnet(0), lan(1), ep('http://mac.local:8810', 'bonjour', 2)],
    }
    const { fn, calls } = recorder((url) => (url.endsWith('/api/health') ? healthOK() : pairOK()))
    const outcome = await pairFirstReachable(withRoutes, TOKEN, 'Seeker', { fetchFn: fn })
    expect(outcome.response.token).toBe('omb_dev_testtoken')
    expect(calls.every((call) => !call.url.includes('192.168') && !call.url.includes('.local'))).toBe(true)
  })

  it('a quick response does not outrank the preferred route', async () => {
    const connection: Connection = {
      id: 'x',
      name: 'Ada',
      host: 'ada.ts.net',
      port: 8810,
      endpoints: [tailnet(0), hosted(1)],
      allowedRouteKinds: ['tailnet', 'hosted'],
      allowedLocalRouteUrls: [],
    }
    const { fn, calls } = recorder(async (url) => {
      if (url.endsWith('/api/health')) {
        if (url.includes('ada.ts.net')) await new Promise((resolve) => setTimeout(resolve, 30))
        return healthOK()
      }
      return pairOK()
    })
    const outcome = await pairFirstReachable(connection, TOKEN, 'Seeker', { fetchFn: fn })
    expect(outcome.connection.activeEndpoint?.kind).toBe('tailnet')
    expect(calls.filter((c) => c.url.endsWith('/api/pair'))).toHaveLength(1)
    expect(calls.find((c) => c.url.endsWith('/api/pair'))?.url).toContain('ada.ts.net')
  })

  it('a transport failure retries a protected fallback with the same request id', async () => {
    const connection: Connection = {
      id: 'x',
      name: 'Ada',
      host: 'companion.example.com',
      port: 443,
      endpoints: [hosted(0), tailnet(1)],
      allowedRouteKinds: ['hosted', 'tailnet'],
      allowedLocalRouteUrls: [],
    }
    const pairBodies: Record<string, unknown>[] = []
    const { fn } = recorder((url, body) => {
      if (url.endsWith('/api/health')) return healthOK()
      pairBodies.push(body ?? {})
      if (url.startsWith('https://')) throw new Error('connection reset')
      return pairOK()
    })
    const outcome = await pairFirstReachable(connection, TOKEN, 'Seeker', { fetchFn: fn, pairRequestId: 'stable-id' })
    expect(outcome.connection.activeEndpoint?.kind).toBe('tailnet')
    expect(pairBodies).toHaveLength(2)
    expect(pairBodies.every((body) => body['pairRequestId'] === 'stable-id')).toBe(true)
  })

  it('a hosted failure never falls back to direct HTTP', async () => {
    const encoded = encodeEndpoints([{ url: 'https://companion.example.com', kind: 'hosted', priority: 0 }])
    const invite = parsePairingInvite(
      inviteUrl({ address: 'companion.example.com', token: TOKEN, endpoints: encoded }),
    )!
    const { fn, calls } = recorder(() => {
      throw new Error('unreachable')
    })
    await expect(pairFirstReachable(invite.connection, TOKEN, 'Seeker', { fetchFn: fn })).rejects.toBeInstanceOf(
      PairingRouteError,
    )
    expect(calls.every((call) => call.url.startsWith('https://'))).toBe(true)
  })

  it('all failed probes leave the credential unspent', async () => {
    const invite = parsePairingInvite(inviteUrl({ address: 'ada.ts.net:8810', token: TOKEN }))!
    const { fn, calls } = recorder(() => {
      throw new Error('unreachable')
    })
    const error = await pairFirstReachable(invite.connection, TOKEN, 'Seeker', { fetchFn: fn }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PairingRouteError)
    expect((error as PairingRouteError).attemptedHosts).toEqual(['http://ada.ts.net:8810'])
    expect(calls.filter((call) => call.url.endsWith('/api/pair'))).toHaveLength(0)
  })

  it('rejects a service that does not identify as Clawd Bot', async () => {
    const invite = parsePairingInvite(inviteUrl({ address: 'ada.ts.net:8810', token: TOKEN }))!
    const { fn, calls } = recorder((url) =>
      url.endsWith('/api/health') ? jsonResponse(200, { app: 'something-else' }) : pairOK(),
    )
    await expect(pairFirstReachable(invite.connection, TOKEN, 'Seeker', { fetchFn: fn })).rejects.toBeInstanceOf(
      PairingRouteError,
    )
    expect(calls.filter((call) => call.url.endsWith('/api/pair'))).toHaveLength(0)
  })

  it('a pairing rejection is not sent to another route', async () => {
    const connection: Connection = {
      id: 'x',
      name: 'Ada',
      host: 'companion.example.com',
      port: 443,
      endpoints: [hosted(0), tailnet(1)],
      allowedRouteKinds: ['hosted', 'tailnet'],
      allowedLocalRouteUrls: [],
    }
    const { fn, calls } = recorder((url) =>
      url.endsWith('/api/health') ? healthOK() : jsonResponse(401, { error: 'That pairing code has expired.' }),
    )
    const error = await pairFirstReachable(connection, TOKEN, 'Seeker', { fetchFn: fn }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CompanionApiError)
    expect((error as CompanionApiError).status).toBe(401)
    expect((error as CompanionApiError).message).toBe('That pairing code has expired.')
    expect(calls.filter((call) => call.url.endsWith('/api/pair'))).toHaveLength(1)
  })

  it('an explicit manual LAN connection still pairs', async () => {
    const connection = establishRoutePolicyFromInvite(parseConnection('192.168.1.20')!)
    const { fn, calls } = recorder((url) => (url.endsWith('/api/health') ? healthOK() : pairOK()))
    const outcome = await pairFirstReachable(connection, '123456', 'Seeker', { fetchFn: fn })
    expect(outcome.response.serverName).toBe("Ada's computer")
    expect(calls.find((c) => c.url.endsWith('/api/pair'))?.body?.['code']).toBe('123456')
  })

  it('a pair response cannot widen the invite consent', async () => {
    const invite = parsePairingInvite(inviteUrl({ address: 'ada.ts.net:8810', token: TOKEN }))!
    const { fn } = recorder((url) =>
      url.endsWith('/api/health')
        ? healthOK()
        : pairOK({ hosts: ['192.168.9.9'], endpoints: [{ url: 'http://192.168.9.9:8810', kind: 'lan', priority: 0 }] }),
    )
    const outcome = await pairFirstReachable(invite.connection, TOKEN, 'Seeker', { fetchFn: fn })
    expect(outcome.connection.hosts ?? []).not.toContain('192.168.9.9')
    expect((outcome.connection.endpoints ?? []).some((e) => e.url.includes('192.168'))).toBe(false)
  })
})
