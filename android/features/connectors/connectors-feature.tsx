import { useFocusEffect } from 'expo-router'
import React, { useCallback, useState } from 'react'
import { Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import { AppActionButton } from '@/components/app-action-button'
import { connectorAccountIsActive, connectorRows } from '@/companion-core/connectors'
import { appStyles } from '@/constants/app-styles'
import { useCompanion } from '@/features/companion/companion-provider'

/**
 * Connected apps — the phone's inventory of what the computer's bots can
 * act through. The status read is the inventory (a catalog page is not an
 * account list): connected services and their accounts come from
 * /api/connectors/connected; the catalog only labels them and shows what
 * else could be connected. Starting an authorization opens the provider's
 * https page in the browser; revocation deliberately stays on the
 * computer, so there is no disconnect button here. The screen refetches
 * whenever it regains focus, so finishing in the browser shows up on
 * return without a manual refresh.
 */
export function ConnectorsFeature() {
  const { session, ready } = useCompanion()
  const [rows, setRows] = useState<ReturnType<typeof connectorRows>>([])
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null)
  const [alias, setAlias] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!session) return
    const [catalog, statuses] = await Promise.all([
      session.connectorCatalog().catch(() => null),
      session.connectorStatuses().catch(() => null),
    ])
    if (!catalog && !statuses) {
      setError('Connector status could not be loaded from the computer.')
    } else {
      setError(null)
    }
    setConfigured(Boolean(statuses?.configured ?? catalog?.configured))
    setRows(connectorRows(catalog, statuses))
    setLoaded(true)
  }, [session])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  if (!ready) return <Text>Loading…</Text>
  if (!session) return <Text>Pair with your computer first — connectors live on it.</Text>
  if (session.status === 'revoked') {
    return <Text>This device was revoked on the computer. Pair again from the home screen to see connectors.</Text>
  }

  const startAuthorization = async (slug: string) => {
    try {
      const url = await session.authorizeConnector(slug, alias.trim() ? alias.trim() : undefined)
      await Linking.openURL(url)
      setExpandedSlug(null)
      setAlias('')
      setNotice('Finish authorizing in the browser, then come back — this screen refreshes itself.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Authorization could not be started.')
    }
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 12 }}>
      {error ? <Text style={appStyles.textDanger}>{error}</Text> : null}
      {notice ? <Text>{notice}</Text> : null}
      {!loaded ? <Text>Loading connectors…</Text> : null}
      {loaded && configured === false ? (
        <Text>
          Connectors aren’t set up on this computer yet. They run through Composio, which is configured on the desktop.
        </Text>
      ) : null}
      {loaded && configured && rows.length === 0 ? <Text>Nothing in the catalog yet.</Text> : null}

      {rows.map((row) => (
        <View key={row.slug} style={appStyles.card}>
          <View style={appStyles.stack}>
            <Text style={{ fontWeight: 'bold' }}>
              {row.label}
              {row.domain ? ` · ${row.domain}` : ''}
            </Text>
            {row.blurb ? <Text>{row.blurb}</Text> : null}
            {row.connected ? (
              <>
                <Text style={appStyles.textSuccess}>● Connected</Text>
                {row.accounts.map((account) => (
                  <Text key={account.id}>
                    {account.alias ?? account.id} —{' '}
                    {connectorAccountIsActive(account) ? 'active' : account.status.toLowerCase()}
                  </Text>
                ))}
              </>
            ) : row.pending ? (
              <Text>◌ Authorization pending — finish it in the browser.</Text>
            ) : (
              <Text>○ Not connected</Text>
            )}
            {!row.connected && expandedSlug !== row.slug ? (
              <AppActionButton
                title={row.pending ? 'Restart authorization' : 'Connect'}
                onPress={async () => {
                  setExpandedSlug(row.slug)
                  setNotice(null)
                }}
              />
            ) : null}
            {!row.connected && expandedSlug === row.slug ? (
              <>
                <TextInput
                  style={localStyles.input}
                  placeholder="Account label (optional) — e.g. work"
                  value={alias}
                  onChangeText={setAlias}
                />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <AppActionButton title="Open authorization" onPress={() => startAuthorization(row.slug)} />
                  <AppActionButton
                    title="Cancel"
                    onPress={async () => {
                      setExpandedSlug(null)
                      setAlias('')
                    }}
                  />
                </View>
              </>
            ) : null}
          </View>
        </View>
      ))}

      <Text>Disconnecting an account happens on the computer — the paired-device boundary keeps revocation there.</Text>
    </ScrollView>
  )
}

const localStyles = StyleSheet.create({
  input: {
    borderColor: '#d1d1d1',
    borderRadius: 2,
    borderWidth: 1,
    padding: 8,
  },
})
