import { useRouter } from 'expo-router'
import React, { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import type { SearchHit } from '@/companion-core/models'
import { appStyles } from '@/constants/app-styles'
import { useCompanion } from '@/features/companion/companion-provider'

/**
 * Search every transcript — the phone-side face of GET /api/search.
 * Debounced as you type; each hit shows where it lives (bot or room, and
 * the task when the harness names one) and its snippet with the match
 * bolded. Tapping a hit opens the thread landed on that message: the chat
 * screen fetches the page around it when it is not already held.
 */
export function SearchFeature() {
  const router = useRouter()
  const { session, ready } = useCompanion()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)

  useEffect(() => {
    const trimmed = query.trim()
    if (!session || trimmed.length === 0) {
      setHits([])
      setSearched(false)
      setError(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const ticket = ++sequence.current
    const timer = setTimeout(() => {
      session
        .search(trimmed)
        .then((results) => {
          if (sequence.current !== ticket) return
          setHits(results)
          setSearched(true)
          setError(null)
        })
        .catch((caught) => {
          if (sequence.current !== ticket) return
          setError(caught instanceof Error ? caught.message : 'Search failed.')
          setSearched(true)
        })
        .finally(() => {
          if (sequence.current === ticket) setSearching(false)
        })
    }, 300)
    return () => clearTimeout(timer)
  }, [query, session])

  if (!ready) {
    return <Text>Loading…</Text>
  }
  if (!session) {
    return <Text>Pair with your computer first — search reads its transcripts.</Text>
  }
  if (session.status === 'revoked') {
    return <Text>This device was revoked on the computer. Pair again from the home screen to search.</Text>
  }

  return (
    <View style={{ gap: 12 }}>
      <TextInput
        style={localStyles.input}
        placeholder="Search messages…"
        value={query}
        onChangeText={setQuery}
        autoFocus
        returnKeyType="search"
      />
      {searching ? <Text>Searching…</Text> : null}
      {error ? <Text>{error}</Text> : null}
      {searched && !searching && hits.length === 0 && !error ? <Text>No matches for “{query.trim()}”.</Text> : null}
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {hits.map((hit) => (
          <Pressable
            key={`${hit.threadId}:${hit.messageId}`}
            onPress={() =>
              router.push({ pathname: '/thread/[id]', params: { id: hit.threadId, highlight: hit.messageId } })
            }
          >
            <View style={appStyles.card}>
              <Text style={{ fontWeight: 'bold' }}>
                {hit.name}
                {hit.task ? ` · ${hit.task}` : ''}
              </Text>
              <Text>
                {hit.snippet.slice(0, hit.matchStart)}
                <Text style={{ fontWeight: 'bold' }}>
                  {hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)}
                </Text>
                {hit.snippet.slice(hit.matchStart + hit.matchLength)}
              </Text>
              <Text>{new Date(hit.at).toLocaleString()}</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
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
