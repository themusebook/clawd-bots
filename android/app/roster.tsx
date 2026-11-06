import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import React from 'react'
import { appStyles } from '@/constants/app-styles'
import { RosterFeature } from '@/features/roster/roster-feature'

/**
 * The roster — mirrors iOS App/ChatListView.swift. The screen itself is
 * features/roster/roster-feature.tsx, rendering the CompanionProvider's
 * LiveSession: hydrate + stream fold, Updates pill, revoked-device state,
 * and a New bot action. Rows open /thread/[id].
 */
export default function RosterScreen() {
  return (
    <SafeAreaView style={appStyles.screen}>
      <View style={appStyles.stack}>
        <Text style={appStyles.title}>Your bots</Text>
        <RosterFeature />
      </View>
    </SafeAreaView>
  )
}
