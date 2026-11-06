import { describe, expect, it } from 'vitest'

import { connectorAccountIsActive, connectorRows } from './connectors'
import type { ConnectorCatalog, ConnectorStatuses } from './models'

describe('connectorAccountIsActive', () => {
  it('is an exact normalized comparison — INACTIVE is not active', () => {
    expect(connectorAccountIsActive({ id: 'a', status: 'ACTIVE' })).toBe(true)
    expect(connectorAccountIsActive({ id: 'a', status: ' active ' })).toBe(true)
    expect(connectorAccountIsActive({ id: 'a', status: 'INACTIVE' })).toBe(false)
    expect(connectorAccountIsActive({ id: 'a', status: 'INITIATED' })).toBe(false)
  })
})

describe('connectorRows', () => {
  const catalog: ConnectorCatalog = {
    configured: true,
    cards: [
      { slug: 'github', label: 'GitHub', blurb: 'Repos and issues' },
      { slug: 'gmail', label: 'Gmail', blurb: 'Mail' },
    ],
  }
  const statuses: ConnectorStatuses = {
    configured: true,
    services: {
      gmail: { connected: true, accounts: [{ id: 'acc-1', alias: 'work', status: 'ACTIVE' }] },
      notion: { connected: false, pending: true },
    },
  }

  it('statuses are the inventory; the catalog only labels and extends', () => {
    const rows = connectorRows(catalog, statuses)
    // Connected first (gmail), then pending (notion — not even in the
    // catalog), then merely available (github).
    expect(rows.map((row) => row.slug)).toEqual(['gmail', 'notion', 'github'])
    expect(rows[0].label).toBe('Gmail')
    expect(rows[0].accounts).toHaveLength(1)
    expect(rows[1].label).toBe('notion')
    expect(rows[2].connected).toBe(false)
  })

  it('tolerates either side missing', () => {
    expect(connectorRows(null, null)).toEqual([])
    expect(connectorRows(catalog, null).map((row) => row.slug)).toEqual(['github', 'gmail'])
  })
})
