import type { ConnectorAccount, ConnectorCatalog, ConnectorStatuses } from './models'

/**
 * Connector presentation rules — from Models.swift:
 *
 * - The STATUSES read is the inventory ("a catalog page is not an account
 *   list"): what is connected comes from /api/connectors/connected; the
 *   catalog only supplies labels, blurbs, and what else could be connected.
 * - An account is active only when its status is exactly ACTIVE after
 *   trimming and uppercasing — Composio also returns INACTIVE, which a
 *   substring check would happily render as connected.
 */

export function connectorAccountIsActive(account: ConnectorAccount): boolean {
  return account.status.trim().toUpperCase() === 'ACTIVE'
}

export interface ConnectorRow {
  slug: string
  label: string
  blurb?: string
  domain?: string
  connected: boolean
  pending: boolean
  accounts: ConnectorAccount[]
}

/** Union of catalog + statuses, connected first, then pending, then the rest by label. */
export function connectorRows(catalog: ConnectorCatalog | null, statuses: ConnectorStatuses | null): ConnectorRow[] {
  const bySlug = new Map<string, ConnectorRow>()
  for (const card of catalog?.cards ?? []) {
    bySlug.set(card.slug, {
      slug: card.slug,
      label: card.label,
      blurb: card.blurb,
      domain: card.domain,
      connected: false,
      pending: false,
      accounts: [],
    })
  }
  for (const [slug, status] of Object.entries(statuses?.services ?? {})) {
    const row = bySlug.get(slug) ?? { slug, label: slug, connected: false, pending: false, accounts: [] }
    row.connected = status.connected
    row.pending = status.pending === true
    row.accounts = status.accounts ?? []
    bySlug.set(slug, row)
  }
  const rank = (row: ConnectorRow) => (row.connected ? 0 : row.pending ? 1 : 2)
  return [...bySlug.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
}
