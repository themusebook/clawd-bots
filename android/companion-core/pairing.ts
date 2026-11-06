/**
 * Pairing — port of the iOS pairing flow (`Client.swift`: PairingInvite,
 * CompanionClient.pair / pairFirstReachable, and `Endpoint.swift`'s policy).
 *
 * A pairing invite is a QR / deep link: `clawdbot://pair?address=…&token=…`
 * (or `&code=…` from an older desktop). It contains only an address and a
 * short-lived, single-use credential. The long-lived device token is created
 * by the pairing exchange and never appears in a link.
 *
 * The security shape, which the tests in `pairing.test.ts` pin down (they
 * mirror PairingTests.swift):
 *  - Health probes are non-mutating and identify the service (`app` must be
 *    "clawdbot") before any credential is sent anywhere.
 *  - Only routes the pairing's policy allows are ever probed or redeemed on;
 *    cleartext LAN/Bonjour routes are excluded from automatic pairing unless
 *    that exact route was the user's explicit choice.
 *  - A quick cleartext answer must not outrank the preferred protected
 *    route — the winner is chosen in advertised priority order.
 *  - A pairing rejection (a status error) is authoritative: it is never
 *    sprayed at another address. Transport failures and gateway statuses
 *    (502–504, 520–530) belong to the route, so the walk continues — with
 *    the SAME pairRequestId, which makes redemption safely replayable if a
 *    response was lost after the computer committed the device.
 *  - If no route is healthy, the credential is left unspent and a
 *    PairingRouteError is thrown: the invite is still valid, offer Retry.
 */

import {
  applyPairingAdvertisement,
  automaticEndpoints,
  baseUrl,
  dialing,
  establishRoutePolicyFromInvite,
  parseConnection,
  type Connection,
} from './connection'
import { createEndpoint, type CompanionEndpoint } from './endpoint'
import type { PairResponse } from './models'

// MARK: - Errors

/** The harness answered, and said no. Its message is written for people. */
export class CompanionApiError extends Error {
  constructor(
    readonly status: number,
    message?: string,
  ) {
    super(message ?? defaultStatusMessage(status))
    this.name = 'CompanionApiError'
  }
  /** The one error that means "back to pairing", not "try again in a moment". */
  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

function defaultStatusMessage(status: number): string {
  switch (status) {
    case 401:
      return 'This phone is not paired with that computer.'
    case 403:
      return 'That can only be done on the computer itself.'
    case 404:
      return 'That is no longer there.'
    case 409:
      return 'The bot is busy — stop it first.'
    default:
      return `The computer answered with an error (${status}).`
  }
}

/** Could not reach it at all — a route problem, not an answer. */
export class TransportError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'TransportError'
  }
}

/**
 * None of the advertised routes answered the health check. Distinct from a
 * pairing rejection: this invite is still valid and the UI can offer Retry
 * without making someone scan it again.
 */
export class PairingRouteError extends Error {
  constructor(readonly attemptedHosts: string[]) {
    super(
      `Couldn’t reach this computer through any available route (${attemptedHosts.join(', ')}). ` +
        'Keep Phone access turned on in Clawd Bot, then try again.',
    )
    this.name = 'PairingRouteError'
  }
}

/**
 * Classify errors another advertised route can actually repair: transport
 * failures about the address, 502–504, and the 520–530 gateway family.
 * Application errors such as 400/401/500 deliberately stay put.
 */
export function shouldTryAnotherRoute(error: unknown): boolean {
  if (error instanceof TransportError) return true
  if (error instanceof CompanionApiError) {
    return (error.status >= 502 && error.status <= 504) || (error.status >= 520 && error.status <= 530)
  }
  return false
}

// MARK: - Fetch plumbing (injectable for tests)

export interface FetchResponseLike {
  status: number
  ok: boolean
  json(): Promise<unknown>
  text(): Promise<string>
  /** Present on real fetch responses; binary endpoints (export, images, voice) need these. */
  headers?: { get(name: string): string | null }
  arrayBuffer?: () => Promise<ArrayBuffer>
}

export type FetchFn = (url: string, init: Record<string, unknown>) => Promise<FetchResponseLike>

const defaultFetch: FetchFn = (url, init) => fetch(url, init as RequestInit) as Promise<FetchResponseLike>

async function fetchWithTimeout(
  fetchFn: FetchFn,
  url: string,
  init: Record<string, unknown>,
  timeoutSeconds: number,
): Promise<FetchResponseLike> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
  try {
    return await fetchFn(url, { ...init, signal: controller.signal })
  } catch (error) {
    throw new TransportError(error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }
}

async function checkStatus(response: FetchResponseLike): Promise<void> {
  if (response.status >= 200 && response.status < 300) return
  let message: string | undefined
  try {
    const body = (await response.json()) as { error?: string }
    if (typeof body?.error === 'string') message = body.error
  } catch {
    // A non-JSON error body just means the default message applies.
  }
  throw new CompanionApiError(response.status, message)
}

async function sendJson<T>(
  fetchFn: FetchFn,
  connection: Connection,
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  timeoutSeconds: number,
  token?: string,
): Promise<T> {
  const base = baseUrl(connection)
  if (!base) throw new TransportError("That address doesn't look right.")
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (body) headers['Content-Type'] = 'application/json'
  const response = await fetchWithTimeout(
    fetchFn,
    `${base}${path}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined },
    timeoutSeconds,
  )
  await checkStatus(response)
  try {
    return (await response.json()) as T
  } catch {
    throw new TransportError("The computer sent something this app couldn't read.")
  }
}

// MARK: - The invite

export interface PairingInvite {
  connection: Connection
  credential: string
}

const BASE64URL_CHARS = /^[0-9A-Za-z_-]+$/

function cleanDisplayName(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Keep non-ASCII (names are people's names) but strip control characters.
  const cleaned = [...trimmed].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0
    if (code > 127) return ch !== '\n'
    return code >= 32 && code !== 127
  })
  const name = cleaned.join('').slice(0, 80)
  return name ? name : null
}

function credentialFrom(values: Map<string, string>): string | null {
  const token = values.get('token')
  if (token !== undefined) {
    if (!token.startsWith('omb_pair_')) return null
    if (new TextEncoder().encode(token).length !== 52) return null
    const rest = token.slice('omb_pair_'.length)
    if (![...rest].every((ch) => /[0-9A-Za-z_-]/.test(ch))) return null
    return token
  }
  const code = values.get('code')
  if (code === undefined) return null
  if (new TextEncoder().encode(code).length !== 6) return null
  if (![...code].every((ch) => ch >= '0' && ch <= '9')) return null
  return code
}

function decodeEndpoints(encoded: string): CompanionEndpoint[] | null {
  if (!encoded || new TextEncoder().encode(encoded).length > 8_192 || !BASE64URL_CHARS.test(encoded)) return null
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  base64 += '='.repeat((4 - (base64.length % 4)) % 4)
  let json: string
  try {
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    json = new TextDecoder().decode(bytes)
  } catch {
    return null
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(decoded) || decoded.length === 0 || decoded.length > 8) return null
  const validated: CompanionEndpoint[] = []
  for (const item of decoded as Array<{ url?: unknown; kind?: unknown; priority?: unknown }>) {
    if (typeof item?.url !== 'string' || typeof item?.kind !== 'string' || typeof item?.priority !== 'number') {
      return null
    }
    const endpoint = createEndpoint(item.url, item.kind as CompanionEndpoint['kind'], item.priority)
    if (!endpoint) return null
    validated.push(endpoint)
  }
  const stable = validated
    .map((endpoint, offset) => ({ endpoint, offset }))
    .sort((a, b) =>
      a.endpoint.priority === b.endpoint.priority ? a.offset - b.offset : a.endpoint.priority - b.endpoint.priority,
    )
    .map(({ endpoint }) => endpoint)
  const seen = new Set<string>()
  const unique = stable.filter((endpoint) => {
    if (seen.has(endpoint.url)) return false
    seen.add(endpoint.url)
    return true
  })
  return unique.length ? unique : null
}

/**
 * Parse a pairing QR / deep link. A present-but-invalid `endpoints` value
 * rejects the invite outright — quietly downgrading a hosted HTTPS QR to its
 * legacy HTTP address is exactly what must not happen.
 */
export function parsePairingInvite(rawUrl: string): PairingInvite | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol.toLowerCase() !== 'clawdbot:') return null
  if (url.hostname.toLowerCase() !== 'pair') return null

  const values = new Map<string, string>()
  for (const [name, value] of url.searchParams) {
    if (values.has(name)) return null // duplicate query keys reject the invite
    values.set(name, value)
  }

  const address = values.get('address')
  const credential = credentialFrom(values)
  if (!address || !credential) return null
  let connection = parseConnection(address)
  if (!connection) return null

  const name = values.get('name')
  if (name !== undefined) {
    const cleaned = cleanDisplayName(name)
    if (cleaned) connection = { ...connection, name: cleaned }
  }

  const list = values.get('hosts')
  if (list !== undefined) {
    const candidates = list
      .split(',')
      .map((candidate) => candidate.trim())
      .filter(
        (candidate) =>
          candidate.length > 0 && new TextEncoder().encode(candidate).length <= 253 && !/[\s/?#]/.test(candidate),
      )
    if (candidates.length) connection = { ...connection, hosts: candidates.slice(0, 8) }
  }

  const encoded = values.get('endpoints')
  if (encoded !== undefined) {
    const endpoints = decodeEndpoints(encoded)
    if (!endpoints) return null
    connection = dialing({ ...connection, endpoints }, endpoints[0])
  }

  connection = establishRoutePolicyFromInvite(connection)
  return { connection, credential }
}

// MARK: - The exchange

export interface PairOptions {
  fetchFn?: FetchFn
  pairRequestId?: string
}

function newPairRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID ? c.randomUUID() : `pair-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isSixDigitCode(credential: string): boolean {
  return credential.length === 6 && [...credential].every((ch) => ch >= '0' && ch <= '9')
}

/** Shape check for a manually typed credential (QR token or legacy code). */
export function looksLikeCredential(value: string): boolean {
  if (isSixDigitCode(value)) return true
  if (!value.startsWith('omb_pair_')) return false
  if (new TextEncoder().encode(value).length !== 52) return false
  return [...value.slice('omb_pair_'.length)].every((ch) => /[0-9A-Za-z_-]/.test(ch))
}

/**
 * Redeem a one-time pairing credential for a device token. The only call
 * made without a device token. An 8s deadline: pairing may move to another
 * advertised route, and one dead address must not consume the API budget.
 */
export async function pair(
  connection: Connection,
  credential: string,
  deviceName: string,
  options: PairOptions = {},
): Promise<PairResponse> {
  const fetchFn = options.fetchFn ?? defaultFetch
  // A six-digit credential is an older desktop or manual entry — keep its
  // field name; new QR credentials use the explicit field and are never
  // persisted by the app.
  const key = isSixDigitCode(credential) ? 'code' : 'credential'
  const body: Record<string, unknown> = { [key]: credential, deviceName }
  if (options.pairRequestId) body['pairRequestId'] = options.pairRequestId
  return sendJson<PairResponse>(fetchFn, connection, 'POST', '/api/pair', body, 8)
}

/** Probe one route: it must answer /api/health AND identify as Clawd Bot. */
export async function probeHealthy(connection: Connection, fetchFn: FetchFn = defaultFetch): Promise<boolean> {
  const base = baseUrl(connection)
  if (!base) return false
  try {
    const response = await fetchWithTimeout(fetchFn, `${base}/api/health`, { method: 'GET', headers: {} }, 4)
    if (response.status < 200 || response.status >= 300) return false
    const body = (await response.json()) as { app?: unknown }
    return body?.app === 'clawdbot'
  } catch {
    return false
  }
}

export interface PairingOutcome {
  response: PairResponse
  /** The winning connection — persist THIS, not the first address in the QR. */
  connection: Connection
}

/**
 * Resolve the multi-address invite before consuming its credential: probe
 * the automatic routes together, redeem only on the first healthy route in
 * advertised priority order, and persist the winner. (The Swift version
 * resolves as soon as a priority prefix settles; this port waits for the
 * probes themselves, each capped at 4s — the chosen winner is the same.)
 */
export async function pairFirstReachable(
  connection: Connection,
  credential: string,
  deviceName: string,
  options: PairOptions = {},
): Promise<PairingOutcome> {
  const fetchFn = options.fetchFn ?? defaultFetch
  const pairRequestId = options.pairRequestId ?? newPairRequestId()
  const endpoints = automaticEndpoints(connection)
  const attemptedRoutes = endpoints.map((endpoint) => endpoint.url)
  let remaining = endpoints.map((endpoint) => dialing(connection, endpoint))

  while (remaining.length) {
    const health = await Promise.all(remaining.map((candidate) => probeHealthy(candidate, fetchFn)))
    const winnerIndex = health.findIndex(Boolean)
    if (winnerIndex < 0) throw new PairingRouteError(attemptedRoutes)
    const winner = remaining[winnerIndex]
    remaining = remaining.filter((_, index) => index !== winnerIndex)
    try {
      const response = await pair(winner, credential, deviceName, { fetchFn, pairRequestId })
      // The response may advertise more routes, but it cannot widen the
      // consent recorded from this invite.
      const committed = applyPairingAdvertisement(winner, response.hosts, response.endpoints)
      return { response, connection: committed }
    } catch (error) {
      // Credential/client errors are authoritative — never spray them at
      // another address. Transport and gateway failures belong to the route;
      // the computer may even have committed the device before a proxy
      // failed, and the shared pairRequestId makes the replay safe.
      if (shouldTryAnotherRoute(error)) continue
      if (error instanceof CompanionApiError) throw error
      continue
    }
  }
  throw new PairingRouteError(attemptedRoutes)
}
