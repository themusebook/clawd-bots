import * as SecureStore from 'expo-secure-store'

import {
  SESSION_STORAGE_KEY,
  parseSession,
  serializeSession,
  type PairedSession,
  type SessionStore,
} from '@/companion-core/session'

/**
 * The production session store: the paired session — device token included —
 * lives in expo-secure-store, which on Android is backed by the Keystore
 * (EncryptedSharedPreferences) and on the web/dev fallback is still the
 * platform's secure enclave path. Never AsyncStorage: that is plain text.
 */
export class SecureSessionStore implements SessionStore {
  async load(): Promise<PairedSession | null> {
    return parseSession(await SecureStore.getItemAsync(SESSION_STORAGE_KEY))
  }

  async save(session: PairedSession): Promise<void> {
    await SecureStore.setItemAsync(SESSION_STORAGE_KEY, serializeSession(session))
  }

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(SESSION_STORAGE_KEY)
  }
}
