import { AccountFeatureIndex } from '@/features/account/account-feature-index'
import { NetworkFeatureIndex } from '@/features/network/network-feature-index'
import { AppConfig } from '@/constants/app-config'
import type { PairedSession } from '@/companion-core/session'
import { SecureSessionStore } from '@/features/pairing/secure-session-store'
import { Link } from 'expo-router'
import { ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import React, { useEffect, useState } from 'react'
import { appStyles } from '@/constants/app-styles'

/**
 * ClawdMobile home. The phone owns nothing — it is a second client of the
 * harness on your computer (see companion-core/). The wallet section below it
 * is the Solana layer iOS cannot have: Wallet UI + Seeker Connect via MWA.
 */
export default function HomeScreen() {
  const [session, setSession] = useState<PairedSession | null>(null)
  useEffect(() => {
    void new SecureSessionStore().load().then(setSession)
  }, [])

  return (
    <SafeAreaView style={appStyles.screen}>
      <ScrollView>
        <View style={appStyles.stack}>
          <Text style={appStyles.title}>ClawdMobile</Text>
          <View style={appStyles.card}>
            <Text>
              Companion for <Text style={{ fontWeight: 'bold' }}>Clawd Bot</Text> on your computer. Your bots keep
              running there — watch them from here, answer their approvals, and send them the next thing.
            </Text>
          </View>

          <Text style={appStyles.title}>Your computer</Text>
          <View style={appStyles.card}>
            {session ? (
              <Text>Paired with {session.connection.name}.</Text>
            ) : (
              <Text>Not paired yet. Pair once with the QR code from Clawd Bot → Settings → Companion.</Text>
            )}
            <Link href="/pairing">{session ? 'Pairing details →' : 'Pair this phone →'}</Link>
            <Link href="/roster">Open the roster →</Link>
          </View>

          <Text style={appStyles.title}>Wallet</Text>
          <View style={appStyles.card}>
            <Text>
              {AppConfig.identity.name} · {AppConfig.identity.uri}
            </Text>
          </View>
          <AccountFeatureIndex />
          <NetworkFeatureIndex />
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
