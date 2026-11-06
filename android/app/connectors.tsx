import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import React from 'react'
import { appStyles } from '@/constants/app-styles'
import { ConnectorsFeature } from '@/features/connectors/connectors-feature'

/**
 * Connected apps. The screen itself is features/connectors/connectors-feature.tsx:
 * the status inventory plus the catalog, and the authorize flow. Revocation
 * stays on the computer by design.
 */
export default function ConnectorsScreen() {
  return (
    <SafeAreaView style={appStyles.screen}>
      <View style={appStyles.stack}>
        <Text style={appStyles.title}>Connected apps</Text>
        <ConnectorsFeature />
      </View>
    </SafeAreaView>
  )
}
