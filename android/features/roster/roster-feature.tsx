import { Link, useRouter } from 'expo-router'
import React from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import { AppActionButton } from '@/components/app-action-button'
import { appStyles } from '@/constants/app-styles'
import { BotAvatar } from '@/features/companion/bot-avatar'
import { useCompanion } from '@/features/companion/companion-provider'

/**
 * The roster — mirrors iOS App/ChatListView.swift: every bot and room, most
 * recent first, unread in bold, and the Updates pill counting only bots that
 * are doing something (the rule shared with the activity notifications).
 * Each row wears its mascot face (the resting expression for its state).
 */
export function RosterFeature() {
  const { session, ready } = useCompanion()
  const router = useRouter()

  if (!ready) {
    return (
      <View style={appStyles.card}>
        <Text>Loading…</Text>
      </View>
    )
  }
  if (!session) {
    return (
      <View style={appStyles.card}>
        <View style={appStyles.stack}>
          <Text>Pair this phone first — the roster is empty until the harness hydrates it.</Text>
          <Link href="/pairing">Pair this phone →</Link>
        </View>
      </View>
    )
  }
  if (session.status === 'revoked') {
    return (
      <View style={appStyles.card}>
        <View style={appStyles.stack}>
          <Text style={appStyles.textDanger}>{session.lastError}</Text>
          <Link href="/pairing">Pair again →</Link>
        </View>
      </View>
    )
  }

  const entries = session.roster()
  const updates = session.updatesCount()
  return (
    <ScrollView>
      <View style={appStyles.stack}>
        {session.status === 'connecting' ? (
          <View style={appStyles.card}>
            <Text>Connecting to your computer…</Text>
          </View>
        ) : null}
        {session.status === 'reconnecting' ? (
          <View style={appStyles.card}>
            <Text>Reconnecting… {session.lastError ?? ''}</Text>
          </View>
        ) : null}
        {updates > 0 ? (
          <View style={appStyles.card}>
            <Text style={{ fontWeight: 'bold' }}>Updates · {updates}</Text>
          </View>
        ) : null}
        {entries.length === 0 && session.status === 'live' ? (
          <View style={appStyles.card}>
            <Text>No bots yet. Make the first one — it shows up here on its own.</Text>
          </View>
        ) : null}
        {entries.map((entry) => (
          <Pressable
            key={entry.threadId}
            onPress={() => {
              router.push({ pathname: '/thread/[id]', params: { id: entry.threadId } })
            }}
          >
            <View style={appStyles.card}>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <BotAvatar
                  avatarUrl={entry.avatarUrl}
                  avatarCrop={entry.avatarCrop}
                  color={entry.color}
                  state={entry.face}
                  size={44}
                />
                <View style={{ flex: 1 }}>
                  <Text style={entry.unread ? { fontWeight: 'bold' } : undefined}>
                    {entry.unread ? '● ' : ''}
                    {entry.name}
                    {entry.kind === 'room' ? ' (room)' : ''}
                  </Text>
                  {entry.title ? <Text>{entry.title}</Text> : null}
                  {entry.lastText ? <Text numberOfLines={2}>{entry.lastText}</Text> : null}
                </View>
              </View>
            </View>
          </Pressable>
        ))}
        <AppActionButton
          title="New bot"
          onPress={async () => {
            await session.createBot()
          }}
        />
        <AppActionButton
          title="Search messages"
          onPress={async () => {
            router.push('/search')
          }}
        />
        <AppActionButton
          title="Routines"
          onPress={async () => {
            router.push('/routines')
          }}
        />
        <AppActionButton
          title="Connected apps"
          onPress={async () => {
            router.push('/connectors')
          }}
        />
      </View>
    </ScrollView>
  )
}
