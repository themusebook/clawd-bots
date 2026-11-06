import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import React from 'react'
import { appStyles } from '@/constants/app-styles'
import { SearchFeature } from '@/features/search/search-feature'

/**
 * Transcript search. The screen itself is features/search/search-feature.tsx;
 * hits open /thread/[id] with a highlight param, and the chat screen lands
 * on the message (fetching the page around it when needed).
 */
export default function SearchScreen() {
  return (
    <SafeAreaView style={appStyles.screen}>
      <View style={appStyles.stack}>
        <Text style={appStyles.title}>Search</Text>
        <SearchFeature />
      </View>
    </SafeAreaView>
  )
}
