/**
 * The pairing flow as a headless state machine — the logic the pairing
 * screen renders. Kept out of React so the whole flow (including what the
 * consent screen claims, and what a retry reuses) is unit-testable.
 *
 * The credential lives in this object, in memory only, for the duration of
 * one review. It is never written to the session store — only the device
 * token returned by the exchange is persisted.
 */

import { directEndpoint } from './endpoint'
import { establishRoutePolicyFromInvite, pairingConsentOrigin, parseConnection, type Connection } from './connection'
import {
  CompanionApiError,
  PairingRouteError,
  looksLikeCredential,
  pairFirstReachable,
  parsePairingInvite,
  type FetchFn,
  type PairingInvite,
} from './pairing'
import type { PairedSession, SessionStore } from './session'

export type PairingPhase =
  | { kind: 'methods' }
  | { kind: 'review'; invite: PairingInvite; consentOrigin: string; transportNote: string }
  | { kind: 'pairing'; invite: PairingInvite; consentOrigin: string; transportNote: string }
  | { kind: 'failed'; invite: PairingInvite | null; message: string; canRetry: boolean }
  | { kind: 'paired'; session: PairedSession }

/**
 * What the consent screen must honestly say about the selected route, from
 * the iOS Connection.baseURL doctrine: hosted is TLS, a tailnet is
 * WireGuard-carried, LAN/Bonjour is cleartext on a trusted-network-only basis.
 */
export function transportNote(connection: Connection): string {
  const kind = connection.activeEndpoint?.kind ?? directEndpoint(connection.host, connection.port, 0)?.kind ?? 'lan'
  switch (kind) {
    case 'hosted':
      return 'Connects over HTTPS — encrypted, and the endpoint is certificate-checked.'
    case 'tailnet':
      return 'Connects inside your tailnet — WireGuard encrypts it end to end, even though the address says http.'
    case 'lan':
    case 'bonjour':
      return 'Cleartext on this network. Pair this way only on a network you trust — at home, not on café or conference wifi.'
  }
}

export interface PairingFlowDeps {
  store: SessionStore
  deviceName: string
  fetchFn?: FetchFn
  now?: () => number
}

function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID ? c.randomUUID() : `pair-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export class PairingFlow {
  phase: PairingPhase = { kind: 'methods' }
  /** One logical pairing attempt per review — retries reuse it (see pairing.ts). */
  private pendingRequestId: string | null = null

  constructor(private readonly deps: PairingFlowDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private review(invite: PairingInvite): void {
    this.pendingRequestId = newRequestId()
    this.phase = {
      kind: 'review',
      invite,
      consentOrigin: pairingConsentOrigin(invite.connection),
      transportNote: transportNote(invite.connection),
    }
  }

  /** A scanned QR, a tapped clawdbot://pair link, or a pasted link. */
  acceptInviteLink(text: string): boolean {
    const invite = parsePairingInvite(text.trim())
    if (!invite) {
      this.pendingRequestId = null
      this.phase = {
        kind: 'failed',
        invite: null,
        message: "That pairing link doesn't look right. Scan the QR from Clawd Bot → Settings → Companion again.",
        canRetry: false,
      }
      return false
    }
    this.review(invite)
    return true
  }

  /** Manual entry: an address (LAN, MagicDNS name, or URL) plus the code or token from the computer. */
  acceptManual(address: string, credential: string): boolean {
    const parsed = parseConnection(address)
    const trimmedCredential = credential.trim()
    if (!parsed || !looksLikeCredential(trimmedCredential)) {
      this.pendingRequestId = null
      this.phase = {
        kind: 'failed',
        invite: null,
        message: !parsed
          ? "That address doesn't look right — try the computer's name or address, like ada.ts.net or 192.168.1.20."
          : "That code doesn't look right — it's the six digits (or the pairing token) shown in Clawd Bot.",
        canRetry: false,
      }
      return false
    }
    this.review({ connection: establishRoutePolicyFromInvite(parsed), credential: trimmedCredential })
    return true
  }

  cancelReview(): void {
    this.pendingRequestId = null
    this.phase = { kind: 'methods' }
  }

  async confirmPair(): Promise<void> {
    const current = this.phase
    const invite = current.kind === 'review' || current.kind === 'failed' ? current.invite : null
    if (!invite) return
    if (current.kind === 'failed' && !current.canRetry) return
    this.phase = {
      kind: 'pairing',
      invite,
      consentOrigin: pairingConsentOrigin(invite.connection),
      transportNote: transportNote(invite.connection),
    }
    try {
      const outcome = await pairFirstReachable(invite.connection, invite.credential, this.deps.deviceName, {
        fetchFn: this.deps.fetchFn,
        pairRequestId: this.pendingRequestId ?? undefined,
      })
      const session: PairedSession = {
        connection: outcome.connection,
        token: outcome.response.token,
        pairedAt: this.now(),
      }
      await this.deps.store.save(session)
      this.pendingRequestId = null
      this.phase = { kind: 'paired', session }
    } catch (error) {
      if (error instanceof PairingRouteError) {
        // The credential was never spent — Retry with the same invite is safe.
        this.phase = { kind: 'failed', invite, message: error.message, canRetry: true }
      } else if (error instanceof CompanionApiError) {
        // The computer answered and said no. The credential is spent or
        // wrong; going back to methods for a fresh QR is the honest path.
        this.phase = { kind: 'failed', invite, message: error.message, canRetry: false }
      } else {
        this.phase = {
          kind: 'failed',
          invite,
          message: error instanceof Error ? error.message : 'Something went wrong while pairing.',
          canRetry: true,
        }
      }
    }
  }

  /** Relaunch proof: a saved session returns straight to "paired" with no new code. */
  async restore(): Promise<boolean> {
    const session = await this.deps.store.load()
    if (!session) return false
    this.phase = { kind: 'paired', session }
    return true
  }

  /** Local unpair: forget the token here. Revoking the device is a computer-side action. */
  async unpair(): Promise<void> {
    await this.deps.store.clear()
    this.pendingRequestId = null
    this.phase = { kind: 'methods' }
  }
}
