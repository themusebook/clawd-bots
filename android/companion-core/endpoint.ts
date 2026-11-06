/**
 * Routes to the desktop companion — port of iOS
 * `Sources/CompanionCore/Endpoint.swift`.
 *
 * Why a route has a kind: the kind is the credential-handling boundary.
 * Hosted HTTPS is authenticated by Web PKI; a Tailscale MagicDNS name is
 * encrypted and authenticated by the tailnet even though its URL says http.
 * LAN and Bonjour routes are deliberately cleartext and require an exact,
 * explicit choice by the user — they are never generic automatic fallbacks
 * for a bearer token or a one-time pairing credential.
 */

export type CompanionEndpointKind = 'hosted' | 'tailnet' | 'lan' | 'bonjour'

export type CompanionEndpointSecurityClass = 'protected' | 'explicitLocal'

export interface CompanionEndpoint {
  url: string
  kind: CompanionEndpointKind
  priority: number
}

export function securityClass(kind: CompanionEndpointKind): CompanionEndpointSecurityClass {
  return kind === 'hosted' || kind === 'tailnet' ? 'protected' : 'explicitLocal'
}

export function protectsCredentials(endpoint: CompanionEndpoint): boolean {
  return securityClass(endpoint.kind) === 'protected'
}

/**
 * The representation URL parsing accepts for a literal IPv6 address: brackets
 * added exactly once, DNS/IPv4 names left alone. An interface zone is kept
 * only on a link-local IPv6 literal; on anything else (a Bonjour-resolved
 * "192.168.1.3%en0") it is dropped, because URL parsers refuse it as a host.
 */
export function urlHost(host: string): string {
  let bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare.includes(':')) return `[${bare}]`
  const zone = bare.indexOf('%')
  if (zone >= 0) bare = bare.slice(0, zone)
  return bare
}

export function canonicalDNSHost(host: string): string {
  let canonical = host.toLowerCase()
  if (canonical.startsWith('[') && canonical.endsWith(']')) canonical = canonical.slice(1, -1)
  while (canonical.endsWith('.')) canonical = canonical.slice(0, -1)
  return canonical
}

export function validTailnetHost(host: string): boolean {
  return host.length > '.ts.net'.length && host.endsWith('.ts.net')
}

/** Recover a direct route's kind from its name (older saved connections). */
export function inferredDirectKind(host: string): CompanionEndpointKind {
  const canonical = canonicalDNSHost(host)
  if (validTailnetHost(canonical)) return 'tailnet'
  if (canonical.endsWith('.local')) return 'bonjour'
  return 'lan'
}

function parseURL(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/**
 * Validate and normalise a route. Returns null for anything that is not an
 * absolute authority the kind allows: hosted requires https, tailnet
 * requires http + a .ts.net name, lan/bonjour require http. No userinfo, no
 * query, no fragment, no path beyond "/".
 */
export function createEndpoint(
  rawUrl: string,
  kind: CompanionEndpointKind,
  priority: number,
): CompanionEndpoint | null {
  const trimmed = rawUrl.trim()
  if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) return null
  if (new TextEncoder().encode(trimmed).length > 2_048) return null
  const url = parseURL(trimmed)
  if (!url) return null
  const scheme = url.protocol.replace(':', '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') return null
  if (!url.hostname) return null
  if (url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== '' && url.pathname !== '/') return null

  const host = url.hostname.toLowerCase()
  switch (kind) {
    case 'hosted':
      if (scheme !== 'https') return null
      break
    case 'tailnet':
      if (scheme !== 'http' || !validTailnetHost(canonicalDNSHost(host))) return null
      break
    case 'lan':
    case 'bonjour':
      if (scheme !== 'http') return null
      break
  }
  if (url.port) {
    const port = Number(url.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  }
  url.protocol = `${scheme}:`
  url.hostname = host
  url.pathname = ''
  // URL keeps a trailing "/" for an empty path; the Swift normal form has none.
  const normalized = url.toString().replace(/\/$/, '')
  return { url: normalized, kind, priority }
}

/** The legacy HTTP route represented by host + port. */
export function directEndpoint(
  host: string,
  port: number,
  priority: number,
  kind?: CompanionEndpointKind,
): CompanionEndpoint | null {
  const resolvedKind = kind ?? inferredDirectKind(host)
  const bare = urlHost(host)
  return createEndpoint(`http://${bare}:${port}`, resolvedKind, priority)
}

export function endpointHost(endpoint: CompanionEndpoint): string {
  const url = parseURL(endpoint.url)
  return url ? urlHost(url.hostname) : ''
}

export function endpointPort(endpoint: CompanionEndpoint): number {
  const url = parseURL(endpoint.url)
  if (!url) return 0
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

export function isSecure(endpoint: CompanionEndpoint): boolean {
  return parseURL(endpoint.url)?.protocol === 'https:'
}

/** Host-only for direct routes, the full HTTPS authority for hosted ones. Display only, never for dialing. */
export function displayAddress(endpoint: CompanionEndpoint): string {
  if (endpoint.kind === 'hosted' || isSecure(endpoint)) return endpoint.url
  const port = endpointPort(endpoint)
  const host = endpointHost(endpoint)
  return port === 8810 ? host : `${host}:${port}`
}

/**
 * The candidates a credential may walk automatically, in caller order.
 * When the preferred route is protected, every cleartext candidate is
 * removed. When it is local, that one exact route is the user's explicit
 * choice and may be tried, followed only by routes which strengthen the
 * transport. Other LAN/Bonjour addresses never receive a token speculatively.
 */
export function automaticCandidates(candidates: CompanionEndpoint[]): CompanionEndpoint[] {
  const preferred = candidates[0]
  if (!preferred) return []
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (seen.has(candidate.url)) return false
    seen.add(candidate.url)
    if (protectsCredentials(preferred)) return protectsCredentials(candidate)
    return candidate.url === preferred.url || protectsCredentials(candidate)
  })
}
