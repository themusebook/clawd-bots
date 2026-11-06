/**
 * The live session — hydrate, stream, fold, reconnect. Headless on purpose:
 * the transport is injected (the app supplies a fetch/XHR stream; tests
 * supply a script), so the reconnect and resume rules are unit-testable.
 *
 * Rules carried from the iOS client:
 *  - Hydrate first (GET /api/bots), then open the stream; a hello with
 *    `resumed: false` means the cursor was not honored — hydrate again.
 *  - The stream is foreground life support: when it drops, reconnect with
 *    backoff and resume from the fold's cursor; nothing is lost because the
 *    fold dedupes by message id.
 *  - A 401 anywhere means the device was revoked: stop, say so plainly, and
 *    let the user pair again. Never retry-loop against a revoked token.
 *  - No optimistic state: sends and answers call the harness and the stream
 *    delivers the result.
 */

import { cardResponseBehavior, isPendingCard, shouldRememberPermission } from './cards'
import { CompanionClient } from './client'
import { ROOM_AVATAR_COLOR, clawdStateForBot, clawdStateForRoom } from './mascot'
import type { Bot, Group, Message, MessageCard } from './models'
import { CompanionApiError, TransportError } from './pairing'
import { SSEParser, decodeFrame } from './sse'
import { applyFrame, hydrate, initialState, updatesFor, type CompanionState } from './store'

export type LiveStatus = 'unpaired' | 'connecting' | 'live' | 'reconnecting' | 'revoked' | 'stopped'

/** Opens the events URL and yields raw text chunks until the stream ends or fails. */
export interface StreamTransport {
  open(url: string, headers: Record<string, string>): AsyncIterable<string>
}

export interface RosterEntry {
  /** Bot id or group id — the send/read verbs are keyed by these, not by thread. */
  id: string
  threadId: string
  kind: 'bot' | 'room'
  name: string
  title?: string
  unread: boolean
  lastText?: string
  lastAt: number
  /** Palette colour name for the mascot (rooms wear the room blue). */
  color: string
  /** The face this row wears right now (ClawdState name). */
  face: string
  /** Custom avatar (bots only, when the harness has one on file). */
  avatarUrl?: string
  avatarCrop?: string
}

export interface PendingCard {
  messageId: string
  card: MessageCard
}

export interface LiveSessionDeps {
  client: CompanionClient
  transport: StreamTransport
  sleep?: (ms: number) => Promise<void>
  onChange?: () => void
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Reconnect backoff: 1s doubling to a 30s ceiling, reset by a healthy hello. */
export function reconnectDelayMs(consecutiveFailures: number): number {
  return Math.min(1000 * 2 ** Math.max(0, consecutiveFailures), 30_000)
}

export class LiveSession {
  state: CompanionState = initialState
  status: LiveStatus = 'connecting'
  lastError: string | null = null
  private stopped = false
  private failures = 0
  private hasMoreByThread = new Map<string, boolean>()

  constructor(private readonly deps: LiveSessionDeps) {}

  private get client(): CompanionClient {
    return this.deps.client
  }

  private emit() {
    this.deps.onChange?.()
  }

  private setStatus(status: LiveStatus) {
    this.status = status
    this.emit()
  }

  /** Hydrate, then run the stream until stop() or revocation. Never throws. */
  async start(): Promise<void> {
    this.stopped = false
    this.setStatus(this.state.hydrated ? 'reconnecting' : 'connecting')
    try {
      await this.hydrateNow()
    } catch (error) {
      if (this.handleFatal(error)) return
      this.lastError = error instanceof Error ? error.message : String(error)
    }
    await this.streamLoop()
  }

  stop(): void {
    this.stopped = true
    this.setStatus('stopped')
  }

  private handleFatal(error: unknown): boolean {
    if (error instanceof CompanionApiError && error.isUnauthorized) {
      this.setStatus('revoked')
      this.lastError = 'This phone is no longer paired with that computer. Pair again to reconnect.'
      return true
    }
    return false
  }

  private async hydrateNow(): Promise<void> {
    const response = await this.client.getBots(50)
    this.state = hydrate(this.state, response)
    for (const bot of response.bots) this.hasMoreByThread.set(bot.threadId, bot.hasMore ?? false)
    for (const group of response.groups) this.hasMoreByThread.set(group.threadId, group.hasMore ?? false)
    this.emit()
  }

  private async streamLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const parser = new SSEParser()
        const stream = this.deps.transport.open(this.client.eventsUrl(this.state.cursor), this.client.streamHeaders)
        for await (const chunk of stream) {
          if (this.stopped) return
          for (const event of parser.feed(chunk)) {
            const frame = decodeFrame(event.data)
            if (!frame) continue
            const isHello = frame.kind === 'hello'
            this.state = applyFrame(this.state, frame)
            if (isHello) {
              this.failures = 0
              this.setStatus('live')
              const hello = frame as Extract<typeof frame, { kind: 'hello' }>
              if (!hello.resumed) {
                // The cursor was not honored: re-hydrate rather than trust a gap.
                await this.hydrateNow()
              }
            }
            this.emit()
          }
        }
        if (this.stopped) return
        throw new TransportError('The event stream ended.')
      } catch (error) {
        if (this.stopped) return
        if (this.handleFatal(error)) return
        this.lastError = error instanceof Error ? error.message : String(error)
        this.setStatus('reconnecting')
        await (this.deps.sleep ?? defaultSleep)(reconnectDelayMs(this.failures))
        this.failures += 1
      }
    }
  }

  // MARK: - Selectors

  /** Roster rows, most recent activity first. */
  roster(): RosterEntry[] {
    const entries: RosterEntry[] = []
    const describe = (threadId: string) => {
      const messages = this.state.messagesByThread[threadId] ?? []
      const last = messages[messages.length - 1]
      return { lastText: last?.text ?? (last?.card ? last.card.title : undefined), lastAt: last?.at ?? 0 }
    }
    for (const bot of this.state.bots) {
      const { lastText, lastAt } = describe(bot.threadId)
      const messages = this.state.messagesByThread[bot.threadId] ?? []
      entries.push({
        id: bot.id,
        threadId: bot.threadId,
        kind: 'bot',
        name: bot.name,
        title: bot.title,
        unread: bot.unread,
        lastText,
        lastAt: lastAt || bot.createdAt,
        color: bot.color,
        face: clawdStateForBot(bot, messages[messages.length - 1]),
        avatarUrl: bot.avatarUrl,
        avatarCrop: bot.avatarCrop,
      })
    }
    for (const group of this.state.groups) {
      const { lastText, lastAt } = describe(group.threadId)
      entries.push({
        id: group.id,
        threadId: group.threadId,
        kind: 'room',
        name: group.name,
        unread: group.unread,
        lastText,
        lastAt: lastAt || group.createdAt,
        color: ROOM_AVATAR_COLOR,
        face: clawdStateForRoom(),
      })
    }
    return entries.sort((a, b) => b.lastAt - a.lastAt)
  }

  /** The Updates pill: only bots doing something. */
  updatesCount(): number {
    return updatesFor(this.state).length
  }

  threadMessages(threadId: string): Message[] {
    return this.state.messagesByThread[threadId] ?? []
  }

  botForThread(threadId: string): Bot | undefined {
    return this.state.bots.find((bot) => bot.threadId === threadId)
  }

  groupForThread(threadId: string): Group | undefined {
    return this.state.groups.find((group) => group.threadId === threadId)
  }

  /** Cards in this thread that still need an answer, oldest first. */
  pendingCards(threadId: string): PendingCard[] {
    return this.threadMessages(threadId)
      .filter((message) => message.card && isPendingCard(message.card))
      .map((message) => ({ messageId: message.id, card: message.card as MessageCard }))
  }

  hasMore(threadId: string): boolean {
    return this.hasMoreByThread.get(threadId) ?? false
  }

  // MARK: - Actions (no optimistic state — the stream delivers results)

  private entryForThread(threadId: string): RosterEntry {
    const entry = this.roster().find((candidate) => candidate.threadId === threadId)
    if (!entry) throw new TransportError('That conversation is no longer on the roster.')
    return entry
  }

  async sendToThread(threadId: string, text: string): Promise<void> {
    const entry = this.entryForThread(threadId)
    if (entry.kind === 'bot') await this.client.sendToBot(entry.id, text)
    else await this.client.sendToRoom(entry.id, text)
  }

  async answerCard(threadId: string, pending: PendingCard, choice: string): Promise<void> {
    // "Always allow" is remembered first, with the card's own key, exactly
    // like Session.answer on iOS — and only in a bot's own thread.
    const bot = this.botForThread(threadId)
    if (bot && shouldRememberPermission(pending.card, choice)) {
      await this.client.alwaysAllow(bot.id, pending.card.allowKey as string)
    }
    const behavior = cardResponseBehavior(pending.card, choice)
    await this.client.respondToThread(
      threadId,
      pending.card.requestId as string,
      behavior,
      behavior === 'answer' ? choice : undefined,
    )
  }

  /**
   * The same answer from something that only has the ids — a notification
   * action. Returns false when the request is not pending anymore (answered
   * elsewhere, or the fold has not caught up yet).
   */
  // MARK: - Routines and inventory (separate reads, not stream state)

  async routines(): Promise<{ routines: import('./models').Routine[]; runs: import('./models').RoutineRun[] }> {
    return this.client.routines()
  }

  async createRoutine(input: import('./models').RoutineInput): Promise<import('./models').Routine> {
    return this.client.createRoutine(input)
  }

  async updateRoutine(id: string, input: import('./models').RoutineInput): Promise<import('./models').Routine> {
    return this.client.updateRoutine(id, input)
  }

  async setRoutineEnabled(id: string, enabled: boolean): Promise<import('./models').Routine> {
    return this.client.setRoutineEnabled(id, enabled)
  }

  async runRoutine(id: string): Promise<import('./models').RoutineRun> {
    return this.client.runRoutine(id)
  }

  async deleteRoutine(id: string): Promise<void> {
    return this.client.deleteRoutine(id)
  }

  async configStatus(): Promise<import('./models').ConfigStatus> {
    return this.client.config()
  }

  async connectorCatalog(): Promise<import('./models').ConnectorCatalog> {
    return this.client.connectorCatalog()
  }

  async connectorStatuses(): Promise<import('./models').ConnectorStatuses> {
    return this.client.connectorStatuses()
  }

  /** Start a connector authorization; returns the https URL to open. Revocation stays on the computer. */
  async authorizeConnector(slug: string, alias?: string): Promise<string> {
    return this.client.authorizeConnector(slug, alias)
  }

  async instances(): Promise<import('./models').Instance[]> {
    return this.client.instances()
  }

  /** Fetch a bot's custom avatar bytes (device bearer attached by the client). */
  async avatarImage(path: string): Promise<Uint8Array> {
    return this.deps.client.avatarData(path)
  }

  async answerByRequest(threadId: string, requestId: string, choice: string): Promise<boolean> {
    const pending = this.pendingCards(threadId).find((candidate) => candidate.card.requestId === requestId)
    if (!pending) return false
    await this.answerCard(threadId, pending, choice)
    return true
  }

  async interruptThread(threadId: string): Promise<void> {
    const entry = this.entryForThread(threadId)
    if (entry.kind !== 'bot') throw new TransportError('Only a bot conversation can be interrupted.')
    await this.client.interruptBot(entry.id)
  }

  /** Opening a conversation marks it read (purpose-built verb, keyed by bot/room). */
  async openThread(threadId: string): Promise<void> {
    const entry = this.roster().find((candidate) => candidate.threadId === threadId)
    if (!entry || !entry.unread) return
    if (entry.kind === 'bot') await this.client.markBotRead(entry.id)
    else await this.client.markRoomRead(entry.id)
  }

  /**
   * Make a bot (roster action). Creating one does not broadcast — the
   * desktop folds its own in too — so the new bot is folded in here rather
   * than waited for (Session.createBot on iOS does the same).
   */
  async createBot(): Promise<Bot> {
    const bot = await this.client.createBot()
    this.state = applyFrame(this.state, { kind: 'bot', bot })
    this.emit()
    return bot
  }

  /** Search every transcript (the search screen's read). */
  async search(query: string, limit = 40): Promise<import('./models').SearchHit[]> {
    return this.client.search(query, limit)
  }

  /**
   * Land on one exact message (a search hit): if it is not already held,
   * fetch the page around it and merge — deduped by id, ordered by time.
   * Returns whether the message is held afterwards. The merge only moves
   * the scrollback boundary when the page actually reached older ground.
   */
  async loadAround(threadId: string, messageId: string): Promise<boolean> {
    const existing = this.threadMessages(threadId)
    if (existing.some((message) => message.id === messageId)) return true
    const page = await this.client.getThreadPage(threadId, { around: messageId, limit: 50 })
    const byId = new Map(existing.map((message) => [message.id, message]))
    for (const message of page.messages) {
      if (!byId.has(message.id)) byId.set(message.id, message)
    }
    const merged = [...byId.values()].sort((a, b) => a.at - b.at)
    const reachedOlder = page.messages.length > 0 && (existing.length === 0 || page.messages[0].at < existing[0].at)
    if (reachedOlder) this.hasMoreByThread.set(threadId, page.hasMore)
    this.state = {
      ...this.state,
      messagesByThread: { ...this.state.messagesByThread, [threadId]: merged },
    }
    this.emit()
    return merged.some((message) => message.id === messageId)
  }

  /** Scrollback: prepend the page before the oldest held message. */
  async loadOlder(threadId: string): Promise<void> {
    if (!this.hasMore(threadId)) return
    const existing = this.threadMessages(threadId)
    const oldest = existing[0]
    if (!oldest) return
    const page = await this.client.getThreadPage(threadId, { before: oldest.id, limit: 50 })
    this.hasMoreByThread.set(threadId, page.hasMore)
    const seen = new Set(existing.map((message) => message.id))
    const older = page.messages.filter((message) => !seen.has(message.id))
    this.state = {
      ...this.state,
      messagesByThread: { ...this.state.messagesByThread, [threadId]: [...older, ...existing] },
    }
    this.emit()
  }
}
