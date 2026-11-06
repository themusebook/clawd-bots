/**
 * Where a companion connects, and with what — port of the iOS `Connection`
 * struct (`Client.swift`) plus its route-policy extensions (`Failover.swift`).
 *
 * The device token is NOT held here — the app keeps it in Keystore-backed
 * storage and hands it to the client at construction, so a Connection can be
 * written to disk without writing a credential.
 *
 * Route policy: `allowedRouteKinds` is null only for connections saved
 * before route consent existed (legacy failover). New pairings always
 * persist a policy. Hosted HTTPS is always allowed kind-wise; a cleartext
 * route additionally has to be the exact origin the user consented to
 * (`allowedLocalRouteUrls`).
 */

import {
  automaticCandidates,
  createEndpoint,
  directEndpoint,
  endpointHost,
  endpointPort,
  inferredDirectKind,
  protectsCredentials,
  securityClass,
  urlHost,
  type CompanionEndpoint,
  type CompanionEndpointKind,
} from './endpoint'

export interface Connection {
  id: string
  /** What the computer calls itself, e.g. "Ada Lovelace's computer". */
  name: string
  host: string
  port: number
  /** Every other address the computer answered on at pairing time, best first. */
  hosts?: string[]
  /** Complete route currently being dialed, when known. */
  activeEndpoint?: CompanionEndpoint
  /** Full routes advertised by a newer desktop (each carries scheme + port). */
  endpoints?: CompanionEndpoint[]
  /** Route kinds this pairing explicitly authorized. Null/absent = legacy. */
  allowedRouteKinds?: CompanionEndpointKind[] | null
  /** Exact cleartext origins the pairing consent screen authorized. */
  allowedLocalRouteUrls?: string[]
}

let fallbackId = 0
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID ? c.randomUUID() : `conn-${Date.now()}-${++fallbackId}`
}

export function allowsRouteKind(connection: Connection, kind: CompanionEndpointKind): boolean {
  if (connection.allowedRouteKinds == null) return true
  return kind === 'hosted' || connection.allowedRouteKinds.includes(kind)
}

export function allowsEndpoint(connection: Connection, endpoint: CompanionEndpoint): boolean {
  if (!allowsRouteKind(connection, endpoint.kind)) return false
  if (securityClass(endpoint.kind) !== 'explicitLocal' || connection.allowedRouteKinds == null) return true
  return (connection.allowedLocalRouteUrls ?? []).includes(endpoint.url)
}

export function endpointsAllowedByRoutePolicy(
  connection: Connection,
  candidates: CompanionEndpoint[],
): CompanionEndpoint[] {
  return candidates.filter((endpoint) => allowsEndpoint(connection, endpoint))
}

function advertisedHostsAllowedByRoutePolicy(connection: Connection, candidates: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of candidates) {
    const normalized = urlHost(candidate)
    if (seen.has(normalized)) continue
    const endpoint = directEndpoint(normalized, connection.port, 0)
    if (!endpoint || !allowsEndpoint(connection, endpoint)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/**
 * Parse a manually entered companion address. A bare IPv6 literal uses the
 * default port; an explicit IPv6 port must use `[address]:port`. An
 * http(s):// URL becomes a typed endpoint (https = hosted; http kind is
 * inferred from the host).
 */
export function parseConnection(text: string, defaultPort = 8810): Connection | null {
  let trimmed = text.trim()
  const lowercased = trimmed.toLowerCase()
  if (lowercased.startsWith('http://') || lowercased.startsWith('https://')) {
    const kind: CompanionEndpointKind = lowercased.startsWith('https://')
      ? 'hosted'
      : inferredDirectKind(new URL(trimmed).hostname ?? '')
    const endpoint = createEndpoint(trimmed, kind, 0)
    if (!endpoint) return null
    return {
      id: newId(),
      name: endpointHost(endpoint),
      host: endpointHost(endpoint),
      port: endpointPort(endpoint),
      activeEndpoint: endpoint,
      endpoints: [endpoint],
    }
  }
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1)
  if (!trimmed) return null

  let host = trimmed
  let port = defaultPort
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']')
    if (close < 0) return null
    host = trimmed.slice(1, close)
    const rest = trimmed.slice(close + 1)
    if (rest) {
      if (!rest.startsWith(':')) return null
      const parsed = Number(rest.slice(1))
      if (!Number.isInteger(parsed)) return null
      port = parsed
    }
  } else if ((trimmed.match(/:/g) ?? []).length === 1) {
    const colon = trimmed.lastIndexOf(':')
    host = trimmed.slice(0, colon)
    const parsed = Number(trimmed.slice(colon + 1))
    if (!Number.isInteger(parsed)) return null
    port = parsed
  }
  if (!host || /[\s/?#[\]]/.test(host) || port < 1 || port > 65_535) return null
  return { id: newId(), name: host, host, port }
}

/**
 * Bind a new pairing to the route the QR/manual choice actually selected.
 * Other fallback addresses in an invite are advisory, not fresh consent.
 * Hosted HTTPS is always retained as a safe future upgrade.
 */
export function establishRoutePolicyFromInvite(connection: Connection): Connection {
  const next: Connection = { ...connection }
  const selected = next.activeEndpoint ?? directEndpoint(next.host, next.port, 0)
  if (!selected) {
    next.allowedRouteKinds = ['hosted']
    next.allowedLocalRouteUrls = []
  } else if (selected.kind === 'hosted') {
    next.allowedRouteKinds = ['hosted']
    next.allowedLocalRouteUrls = []
  } else if (selected.kind === 'tailnet') {
    next.allowedRouteKinds = ['tailnet', 'hosted']
    next.allowedLocalRouteUrls = []
  } else {
    next.allowedRouteKinds = [selected.kind, 'hosted']
    next.allowedLocalRouteUrls = [selected.url]
  }
  if (next.endpoints) next.endpoints = endpointsAllowedByRoutePolicy(next, next.endpoints).slice(0, 8)
  if (next.hosts) next.hosts = advertisedHostsAllowedByRoutePolicy(next, next.hosts).slice(0, 8)
  return next
}

/**
 * Apply the routes a pairing response advertises. The response may advertise
 * every interface on the computer, but it cannot widen the consent recorded
 * from the invite that carried the credential.
 */
export function applyPairingAdvertisement(
  connection: Connection,
  advertisedHosts?: string[],
  advertisedEndpoints?: CompanionEndpoint[],
): Connection {
  const next: Connection = { ...connection }
  if (advertisedHosts?.length) {
    next.hosts = advertisedHostsAllowedByRoutePolicy(next, advertisedHosts).slice(0, 8)
  }
  if (advertisedEndpoints?.length) {
    const accepted = endpointsAllowedByRoutePolicy(next, advertisedEndpoints)
    if (accepted.length) next.endpoints = accepted.slice(0, 8)
  }
  return next
}

/** Every legacy host this connection may dial, best first. */
export function orderedHosts(connection: Connection): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of [connection.host, ...(connection.hosts ?? [])]) {
    const normalized = urlHost(candidate)
    const endpoint = directEndpoint(normalized, connection.port, 0)
    if (!endpoint || !allowsEndpoint(connection, endpoint)) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/**
 * Every complete route in policy order. Typed endpoints win over the legacy
 * fields because they can represent hosted HTTPS — a connection walks the
 * typed set or derives direct routes from host fields, never a mixture.
 */
export function orderedEndpoints(connection: Connection): CompanionEndpoint[] {
  let candidates = [...(connection.endpoints ?? [])]
  if (candidates.length) {
    if (connection.activeEndpoint && !candidates.some((c) => c.url === connection.activeEndpoint!.url)) {
      candidates.push(connection.activeEndpoint)
    }
    candidates = candidates
      .map((endpoint, offset) => ({ endpoint, offset }))
      .sort((a, b) =>
        a.endpoint.priority === b.endpoint.priority ? a.offset - b.offset : a.endpoint.priority - b.endpoint.priority,
      )
      .map(({ endpoint }) => endpoint)
  } else {
    candidates = orderedHosts(connection)
      .map((host, offset) => directEndpoint(host, connection.port, offset))
      .filter((e): e is CompanionEndpoint => e !== null)
  }
  const seen = new Set<string>()
  return endpointsAllowedByRoutePolicy(connection, candidates)
    .filter((endpoint) => {
      if (seen.has(endpoint.url)) return false
      seen.add(endpoint.url)
      return true
    })
    .slice(0, 8)
}

/** The subset an automatic pairing or authenticated reconnect may try. */
export function automaticEndpoints(connection: Connection): CompanionEndpoint[] {
  return automaticCandidates(orderedEndpoints(connection))
}

/** A copy dialing one complete route; stored order and policy untouched. */
export function dialing(connection: Connection, candidate: CompanionEndpoint): Connection {
  if (!allowsEndpoint(connection, candidate)) return connection
  return { ...connection, activeEndpoint: candidate, host: endpointHost(candidate), port: endpointPort(candidate) }
}

/**
 * The base URL to dial, or null when the active route is outside the
 * pairing's policy (fail closed rather than spraying a token).
 * Hosted = validated HTTPS; tailnet = WireGuard-carried http; LAN = cleartext
 * on a trusted network only — see the iOS Connection.baseURL note.
 */
export function baseUrl(connection: Connection): string | null {
  if (connection.activeEndpoint) {
    return allowsEndpoint(connection, connection.activeEndpoint) ? connection.activeEndpoint.url : null
  }
  const direct = directEndpoint(connection.host, connection.port, 0)
  if (!direct || !allowsEndpoint(connection, direct)) return null
  return direct.url
}

/** The normalized origin a person consents to before pairing — no path, query, or credential. */
export function pairingConsentOrigin(connection: Connection): string {
  if (connection.activeEndpoint) return connection.activeEndpoint.url
  const direct = directEndpoint(connection.host.toLowerCase(), connection.port, 0)
  return direct ? direct.url : `${connection.host.toLowerCase()}:${connection.port}`
}

export function connectionDisplayAddress(connection: Connection): string {
  if (connection.activeEndpoint) {
    const endpoint = connection.activeEndpoint
    if (endpoint.kind === 'hosted' || endpoint.url.startsWith('https://')) return endpoint.url
    return endpointPort(endpoint) === 8810
      ? endpointHost(endpoint)
      : `${endpointHost(endpoint)}:${endpointPort(endpoint)}`
  }
  return `${connection.host}:${connection.port}`
}

export { protectsCredentials }
