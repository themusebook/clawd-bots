import { useRouter } from 'expo-router'
import * as Notifications from 'expo-notifications'
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'

import { deriveActivities } from '@/companion-core/activity'
import { CompanionClient } from '@/companion-core/client'
import { LiveSession } from '@/companion-core/live-session'
import {
  ActivityNotificationSync,
  ensureActivityChannel,
  ensureNotificationPermission,
  installNotificationHandler,
  type ActivityNotificationData,
} from '@/features/companion/activity-notifications'
import { FetchStreamTransport } from '@/features/companion/fetch-stream-transport'
import { SecureSessionStore } from '@/features/pairing/secure-session-store'

interface CompanionContextValue {
  /** Null until the store has been read; check `ready` before concluding "unpaired". */
  session: LiveSession | null
  ready: boolean
  /** Bumps on every fold change — consumers re-render and re-read selectors. */
  version: number
  /** Re-read the stored pairing and restart the session (call after pairing/unpairing). */
  reload: () => void
}

const CompanionContext = createContext<CompanionContextValue>({
  session: null,
  ready: false,
  version: 0,
  reload: () => {},
})

/**
 * Owns the one LiveSession for the whole app: built from the stored pairing,
 * started on mount, stopped on unmount. The session itself is headless
 * (companion-core/live-session.ts) — this provider is only its React shelf.
 * It also keeps the BotActivity notifications in sync with the fold and
 * routes notification answers back into the session, the way the iOS app
 * wires its LiveActivityIntent handler at launch.
 */
export function CompanionProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<LiveSession | null>(null)
  const [ready, setReady] = useState(false)
  const [version, setVersion] = useState(0)
  const liveRef = useRef<LiveSession | null>(null)
  const generationRef = useRef(0)
  const router = useRouter()

  const syncRef = useRef<ActivityNotificationSync | null>(null)
  if (!syncRef.current) syncRef.current = new ActivityNotificationSync()
  const permissionAskedRef = useRef(false)
  const queuedAnswerRef = useRef<{ threadId: string; requestId: string; choice: string } | null>(null)
  const handledResponsesRef = useRef(new Set<string>())

  const start = useCallback(async () => {
    const generation = ++generationRef.current
    liveRef.current?.stop()
    liveRef.current = null
    setSession(null)
    setReady(false)
    const stored = await new SecureSessionStore().load()
    if (generation !== generationRef.current) return
    if (!stored) {
      setReady(true)
      return
    }
    const live = new LiveSession({
      client: new CompanionClient(stored.connection, stored.token),
      transport: new FetchStreamTransport(),
      onChange: () => {
        if (generation === generationRef.current) setVersion((value) => value + 1)
      },
    })
    liveRef.current = live
    setSession(live)
    setReady(true)
    void live.start()
  }, [])

  useEffect(() => {
    void start()
    return () => {
      generationRef.current += 1
      liveRef.current?.stop()
    }
  }, [start])

  const reload = useCallback(() => {
    void start()
  }, [start])

  // Keep the ongoing activity notifications in step with the fold, and flush
  // a notification answer that arrived before the fold had the card.
  useEffect(() => {
    const sync = syncRef.current
    if (!sync) return
    if (!session || session.status === 'revoked') {
      void sync.clearAll()
      return
    }
    if (!session.state.hydrated) return
    void (async () => {
      if (!permissionAskedRef.current) {
        permissionAskedRef.current = true
        await ensureActivityChannel()
        await ensureNotificationPermission()
      }
      await sync.sync(deriveActivities(session.state))
      const queued = queuedAnswerRef.current
      if (queued) {
        const answered = await session
          .answerByRequest(queued.threadId, queued.requestId, queued.choice)
          .catch(() => false)
        if (answered) queuedAnswerRef.current = null
      }
    })()
  }, [session, version])

  // Notification answers and taps. An action's identifier IS the card's
  // choice text (see activity-notifications.ts); the body tap opens the thread.
  useEffect(() => {
    installNotificationHandler()
    const handle = (response: Notifications.NotificationResponse) => {
      const key = `${response.notification.request.identifier}:${response.actionIdentifier}`
      if (handledResponsesRef.current.has(key)) return
      handledResponsesRef.current.add(key)
      const data = response.notification.request.content.data as unknown as ActivityNotificationData | undefined
      if (!data?.threadId) return
      if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
        router.push({ pathname: '/thread/[id]', params: { id: data.threadId } })
        return
      }
      if (!data.requestId) return
      const answer = { threadId: data.threadId, requestId: data.requestId, choice: response.actionIdentifier }
      const live = liveRef.current
      if (!live) {
        queuedAnswerRef.current = answer
        return
      }
      void live
        .answerByRequest(answer.threadId, answer.requestId, answer.choice)
        .then((answered) => {
          if (!answered) queuedAnswerRef.current = answer
        })
        .catch(() => {
          queuedAnswerRef.current = answer
        })
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(handle)
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) handle(response)
    })
    return () => subscription.remove()
  }, [router])

  return <CompanionContext.Provider value={{ session, ready, version, reload }}>{children}</CompanionContext.Provider>
}

export function useCompanion(): CompanionContextValue {
  return useContext(CompanionContext)
}
