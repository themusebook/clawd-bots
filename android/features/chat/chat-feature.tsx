import { Link } from 'expo-router'
import React, { useEffect, useRef, useState } from 'react'
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import { AppActionButton } from '@/components/app-action-button'
import { ROOM_AVATAR_COLOR, clawdStateForBot, clawdStateForRoom } from '@/companion-core/mascot'
import type { Message } from '@/companion-core/models'
import { appStyles } from '@/constants/app-styles'
import { BotAvatar } from '@/features/companion/bot-avatar'
import { ClawdAvatarFace } from '@/features/companion/clawd-avatar-face'
import { useCompanion } from '@/features/companion/companion-provider'

const localStyles = StyleSheet.create({
  flash: {
    backgroundColor: '#9945FF26',
    borderColor: '#9945FF',
    borderRadius: 2,
    borderWidth: 1,
  },
  composer: {
    backgroundColor: '#ffffff',
    borderColor: '#d1d1d1',
    borderRadius: 2,
    borderWidth: 1,
    padding: 8,
  },
  mine: {
    fontWeight: 'bold',
  },
})

/**
 * One conversation — mirrors iOS App/ChatView.swift at Tier-1 scope: the
 * transcript from the fold, pending option cards answered in place, a
 * composer, interrupt for bot threads, and scrollback on demand. No
 * optimistic state: a send or an answer calls the harness and the stream
 * delivers what actually happened.
 */
export function ChatFeature({ threadId, highlightId }: { threadId: string; highlightId?: string }) {
  const { session, ready } = useCompanion()
  const [draft, setDraft] = useState('')
  const [flashId, setFlashId] = useState<string | null>(null)
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView> | null>(null)
  const openedRef = useRef<string | null>(null)
  const positionsRef = useRef(new Map<string, number>())
  const landedRef = useRef<string | null>(null)

  useEffect(() => {
    if (session && openedRef.current !== threadId) {
      openedRef.current = threadId
      void session.openThread(threadId).catch(() => {
        // Marking read is housekeeping; a failure shows up as the unread
        // dot staying lit, not as an error over the conversation.
      })
    }
  }, [session, threadId])

  // Search-hit landing: fetch the page around the message if it is not
  // held yet; the scroll itself happens once its row has laid out (below).
  useEffect(() => {
    if (!session || !highlightId) return
    if (session.threadMessages(threadId).some((message) => message.id === highlightId)) return
    void session.loadAround(threadId, highlightId).catch(() => {
      // A hit that cannot be landed on still leaves a working thread.
    })
  }, [session, threadId, highlightId])

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
          <Text>Pair this phone to open this conversation.</Text>
          <Link href="/pairing">Pair this phone →</Link>
        </View>
      </View>
    )
  }
  if (session.status === 'revoked') {
    return (
      <View style={appStyles.card}>
        <Text style={appStyles.textDanger}>{session.lastError}</Text>
      </View>
    )
  }

  const bot = session.botForThread(threadId)
  const group = session.groupForThread(threadId)
  const messages = session.threadMessages(threadId)
  const pending = session.pendingCards(threadId)

  // Land on the search hit once its row has laid out: scroll to it and
  // flash it, exactly once per highlight.
  const maybeLand = (messageId: string, y: number) => {
    if (!highlightId || messageId !== highlightId || landedRef.current === highlightId) return
    landedRef.current = highlightId
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true })
    setFlashId(highlightId)
    setTimeout(() => setFlashId(null), 2600)
  }
  const landingPending = Boolean(highlightId) && landedRef.current !== highlightId

  return (
    <View style={appStyles.stack}>
      <View style={appStyles.card}>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          {bot ? (
            <BotAvatar
              avatarUrl={bot.avatarUrl}
              avatarCrop={bot.avatarCrop}
              color={bot.color}
              state={clawdStateForBot(bot, messages[messages.length - 1])}
              size={44}
            />
          ) : group ? (
            <ClawdAvatarFace color={ROOM_AVATAR_COLOR} state={clawdStateForRoom()} size={44} />
          ) : null}
          <View style={{ flex: 1 }}>
            <Text style={appStyles.title}>{bot?.name ?? group?.name ?? 'Conversation'}</Text>
            {bot?.title ? <Text>{bot.title}</Text> : null}
            {session.status !== 'live' ? (
              <Text>{session.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</Text>
            ) : null}
          </View>
        </View>
      </View>

      {session.hasMore(threadId) ? (
        <AppActionButton
          title="Load earlier messages"
          onPress={async () => {
            await session.loadOlder(threadId)
          }}
        />
      ) : null}

      <ScrollView
        ref={scrollRef}
        onContentSizeChange={() => {
          // While a search landing is pending, the end of the thread is
          // not where the reader is going.
          if (!landingPending) scrollRef.current?.scrollToEnd({ animated: false })
        }}
      >
        <View style={appStyles.stack}>
          {messages.map((message) => (
            <View
              key={message.id}
              onLayout={(event) => {
                positionsRef.current.set(message.id, event.nativeEvent.layout.y)
                maybeLand(message.id, event.nativeEvent.layout.y)
              }}
              style={message.id === flashId ? localStyles.flash : undefined}
            >
              <MessageRow message={message} />
            </View>
          ))}
        </View>
      </ScrollView>

      {pending.map((entry) => (
        <View key={entry.messageId} style={appStyles.card}>
          <View style={appStyles.stack}>
            <Text style={{ fontWeight: 'bold' }}>{entry.card.title}</Text>
            {entry.card.subtitle ? <Text>{entry.card.subtitle}</Text> : null}
            {entry.card.held ? <Text>Auto mode paused: {entry.card.held}</Text> : null}
            {entry.card.options.map((option) => (
              <AppActionButton
                key={option}
                title={option}
                onPress={async () => {
                  await session.answerCard(threadId, entry, option)
                }}
              />
            ))}
          </View>
        </View>
      ))}

      <TextInput
        style={localStyles.composer}
        value={draft}
        onChangeText={setDraft}
        placeholder={bot ? `Message ${bot.name}…` : 'Message the room…'}
        multiline
      />
      <View style={appStyles.stack}>
        <Button
          title="Send"
          disabled={draft.trim().length === 0}
          onPress={() => {
            const text = draft
            setDraft('')
            void session.sendToThread(threadId, text).catch(() => {
              setDraft(text)
            })
          }}
        />
        {bot ? (
          <AppActionButton
            title="Interrupt"
            onPress={async () => {
              await session.interruptThread(threadId)
            }}
          />
        ) : null}
      </View>
    </View>
  )
}

function MessageRow({ message }: { message: Message }) {
  if (message.card) {
    return (
      <View style={appStyles.card}>
        <Text style={{ fontWeight: 'bold' }}>{message.card.title}</Text>
        {message.card.subtitle ? <Text>{message.card.subtitle}</Text> : null}
        {message.card.options.length ? <Text>{message.card.options.join(' · ')}</Text> : null}
        {message.card.answered ? <Text style={appStyles.textSuccess}>Answered: {message.card.answered}</Text> : null}
      </View>
    )
  }
  return (
    <View style={appStyles.card}>
      <Text>
        <Text style={message.role === 'user' ? localStyles.mine : undefined}>
          {message.role === 'user' ? 'You: ' : ''}
        </Text>
        {message.text ?? ''}
      </Text>
    </View>
  )
}
