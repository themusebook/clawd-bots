import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import React from 'react'
import { appStyles } from '@/constants/app-styles'
import { PairingFeature } from '@/features/pairing/pairing-feature'

/**
 * Pairing — mirrors iOS App/PairingView.swift. The screen itself is
 * features/pairing/pairing-feature.tsx (it renders the headless PairingFlow
 * from companion-core): scan the QR from Clawd Bot → Settings → Companion,
 * paste or open a clawdbot://pair link, or type the address (LAN or the
 * Tailscale MagicDNS name — never the 100.64/10 address) plus the code.
 * Confirm-before-connect shows the exact consent origin and an honest
 * transport note; the exchange itself is pairFirstReachable (policy-ordered
 * routes, same pairRequestId on retries), and only the device token is
 * stored, in Keystore-backed secure storage. Relaunch returns to the paired
 * state with no new code. Nearby discovery (Bonjour/NSD) is the remaining
 * entry point — it lands with the first on-device build.
 */
export default function PairingScreen() {
  return (
    <SafeAreaView style={appStyles.screen}>
      <View style={appStyles.stack}>
        <Text style={appStyles.title}>Pair this phone</Text>
        <PairingFeature />
      </View>
    </SafeAreaView>
  )
}
