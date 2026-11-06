/**
 * The persisted pairing: a Connection (safe to write anywhere — it carries
 * no credential) plus the device token (which lives ONLY in platform-secure
 * storage: Keychain on iOS, Keystore-backed encrypted storage on Android).
 *
 * The store interface is the seam: companion-core defines the shape and the
 * serialization rules; the app supplies the SecureStore-backed
 * implementation (features/pairing/secure-session-store.ts). Tests use the
 * in-memory store. The token is never logged, never put in a URL, and never
 * written to AsyncStorage or the filesystem.
 */

import type { Connection } from './connection'

export interface PairedSession {
  connection: Connection
  /** The long-lived device token from the pairing exchange. Handle like a password. */
  token: string
  pairedAt: number
}

export interface SessionStore {
  load(): Promise<PairedSession | null>
  save(session: PairedSession): Promise<void>
  clear(): Promise<void>
}

export const SESSION_STORAGE_KEY = 'clawdmobile.paired-session.v1'

export function serializeSession(session: PairedSession): string {
  return JSON.stringify(session)
}

/** Parse a stored session. Corrupt or partial data reads as "not paired", never as a crash. */
export function parseSession(raw: string | null): PairedSession | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const session = value as Partial<PairedSession>
  if (typeof session?.token !== 'string' || session.token.length === 0) return null
  if (typeof session?.pairedAt !== 'number') return null
  const connection = session.connection as Partial<Connection> | undefined
  if (!connection || typeof connection.host !== 'string' || typeof connection.port !== 'number') return null
  if (typeof connection.id !== 'string' || typeof connection.name !== 'string') return null
  return session as PairedSession
}

/** Test/dev store. Production uses the SecureStore-backed implementation. */
export class MemorySessionStore implements SessionStore {
  private raw: string | null = null

  async load(): Promise<PairedSession | null> {
    return parseSession(this.raw)
  }

  async save(session: PairedSession): Promise<void> {
    this.raw = serializeSession(session)
  }

  async clear(): Promise<void> {
    this.raw = null
  }
}
