import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import React from 'react'
import { appStyles } from '@/constants/app-styles'
import { RoutinesFeature } from '@/features/routines/routines-feature'

/**
 * Routines. The screen itself is features/routines/routines-feature.tsx:
 * the list and runs from GET /api/routines, run/toggle/edit/delete and the
 * create form, all through the narrow client contract.
 */
export default function RoutinesScreen() {
  return (
    <SafeAreaView style={appStyles.screen}>
      <View style={appStyles.stack}>
        <Text style={appStyles.title}>Routines</Text>
        <RoutinesFeature />
      </View>
    </SafeAreaView>
  )
}
