import { useLocalSearchParams } from 'expo-router'
import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import React from 'react'
import { appStyles } from '@/constants/app-styles'
import { ChatFeature } from '@/features/chat/chat-feature'

/**
 * One conversation — mirrors iOS App/ChatView.swift. The screen itself is
 * features/chat/chat-feature.tsx: transcript from the fold, pending option
 * cards answered in place, composer, interrupt, scrollback.
 */
export default function ThreadScreen() {
  const { id, highlight } = useLocalSearchParams<{ id: string; highlight?: string }>()
  return (
    <SafeAreaView style={appStyles.screen}>
      {id ? (
        <ChatFeature threadId={id} highlightId={highlight} />
      ) : (
        <View style={appStyles.card}>
          <Text>That conversation link is missing its thread id.</Text>
        </View>
      )}
    </SafeAreaView>
  )
}
