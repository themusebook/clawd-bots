/**
 * The companion API client — port of iOS `Sources/CompanionCore/Client.swift`
 * ("every call the phone is allowed to make").
 *
 * The allowed / refused surface is enforced server-side by the default-deny
 * policy in the desktop repo's `companion/src/routes.ts`, and mirrored here
 * by simply not having the refused methods:
 *
 *  Allowed:  read bots/rooms/transcripts · search · export · instances and
 *            config · connector catalog/statuses and authorization · message
 *            and avatar images · voices · routines · bot profiles and tasks ·
 *            reactions and edits · send messages · make a bot or a room ·
 *            answer approvals and questions · interrupt a bot · mark chats
 *            read · fetch screen images on demand · open an explicitly
 *            enabled cloud desktop.
 *  Refused:  write API keys · manage pairing or revoke devices · drive the
 *            Local VM or the host computer · `/api/internal/*` · load the
 *            packaged desktop UI · provision/sleep/shell cloud computers.
 *
 * Pairing itself lives in `./pairing.ts` (it is the one flow that runs
 * without a device token, and it has its own route-walking rules).
 *
 * Requests are deliberately short: 20s, like the iOS client. These are calls
 * to a computer on the same network; if it does not answer in twenty seconds
 * it is not going to, and a longer spinner reads as a broken app rather than
 * a wrong address. Error messages pass through from the harness — they are
 * written for people.
 */

import { baseUrl, type Connection } from './connection'
import type {
  Bot,
  BotProfilePatch,
  BotsResponse,
  CloudDesktopSession,
  CompanionConnectionMetadata,
  ConfigStatus,
  ConnectorCatalog,
  ConnectorStatuses,
  Group,
  Instance,
  Message,
  Routine,
  RoutineInput,
  RoutineRun,
  SearchHit,
  ThreadPage,
  TranscriptExport,
  Voice,
} from './models'
import { CompanionApiError, TransportError, type FetchFn, type FetchResponseLike } from './pairing'

const defaultFetch: FetchFn = (url, init) => fetch(url, init as RequestInit) as never

export class CompanionClient {
  constructor(
    readonly connection: Connection,
    /** Device token from the pairing exchange, held in Keystore-backed storage by the app. */
    private readonly token: string | null,
    private readonly fetchFn: FetchFn = defaultFetch,
  ) {}

  /** One HTTP round trip with the shared timeout and error mapping. */
  private async perform(
    method: string,
    path: string,
    query: Record<string, string>,
    init: { json?: Record<string, unknown>; rawBody?: Uint8Array; contentType?: string; timeoutMs?: number },
  ): Promise<FetchResponseLike> {
    const base = baseUrl(this.connection)
    if (!base) throw new TransportError("That address doesn't look right.")
    const qs = new URLSearchParams(query).toString()
    const headers: Record<string, string> = {}
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    let body: string | Uint8Array | undefined
    if (init.json) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.json)
    } else if (init.rawBody) {
      if (init.contentType) headers['Content-Type'] = init.contentType
      body = init.rawBody
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000)
    let response
    try {
      response = await this.fetchFn(`${base}${path}${qs ? `?${qs}` : ''}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      })
    } catch (error) {
      throw new TransportError(error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
    }
    if (response.status < 200 || response.status >= 300) {
      let message: string | undefined
      try {
        const parsed = (await response.json()) as { error?: string }
        if (typeof parsed?.error === 'string') message = parsed.error
      } catch {
        // Default status messages apply.
      }
      throw new CompanionApiError(response.status, message)
    }
    return response
  }

  private async request<T>(
    method: string,
    path: string,
    query: Record<string, string> = {},
    body?: Record<string, unknown>,
    parseJson = true,
    timeoutMs?: number,
  ): Promise<T> {
    const response = await this.perform(method, path, query, { json: body, timeoutMs })
    // The call-and-answer verbs ignore their response bodies entirely (the
    // stream delivers the result), so they skip the decode.
    if (!parseJson) return undefined as T
    try {
      return (await response.json()) as T
    } catch {
      throw new TransportError("The computer sent something this app couldn't read.")
    }
  }

  /** A binary round trip (export, images, voice preview): bytes plus headers. */
  private async requestBytes(
    method: string,
    path: string,
    query: Record<string, string> = {},
    init: { json?: Record<string, unknown>; rawBody?: Uint8Array; contentType?: string; timeoutMs?: number } = {},
  ): Promise<{ bytes: Uint8Array; header(name: string): string | null }> {
    const response = await this.perform(method, path, query, init)
    if (!response.arrayBuffer) {
      throw new TransportError("The computer sent something this app couldn't read.")
    }
    const buffer = await response.arrayBuffer()
    return {
      bytes: new Uint8Array(buffer),
      header: (name: string) => response.headers?.get(name) ?? null,
    }
  }

  private async post(path: string, body?: Record<string, unknown>): Promise<void> {
    await this.request<unknown>('POST', path, {}, body, false)
  }

  /** Hydrate: the roster, with the newest `messages` per thread (paged shape). */
  async getBots(messages = 50): Promise<BotsResponse> {
    return this.request<BotsResponse>('GET', '/api/bots', { messages: String(messages) })
  }

  /** Scrollback: the page before a message already held, or around an exact one (search hits). */
  async getThreadPage(
    threadId: string,
    options: { before?: string; around?: string; limit?: number } = {},
  ): Promise<ThreadPage> {
    const query: Record<string, string> = { limit: String(options.limit ?? 50) }
    if (options.before) query['before'] = options.before
    if (options.around) query['around'] = options.around
    return this.request<ThreadPage>('GET', `/api/threads/${threadId}/messages`, query)
  }

  /** Refresh the routes this paired phone can use (sidecar-owned, authenticated). */
  async connectionMetadata(): Promise<CompanionConnectionMetadata> {
    return this.request<CompanionConnectionMetadata>('GET', '/api/companion/endpoints')
  }

  /** Send a message to a bot's thread. The stream delivers the result — no optimistic state. */
  async sendToBot(botId: string, text: string): Promise<void> {
    await this.post(`/api/bots/${botId}/messages`, { text })
  }

  /** Send a message to a room. */
  async sendToRoom(groupId: string, text: string): Promise<void> {
    await this.post(`/api/groups/${groupId}/messages`, { text })
  }

  /**
   * Answer an approval or a question. Addressed by thread rather than by bot
   * on purpose: a request raised inside a room belongs to whichever member
   * is speaking, and the harness already knows which that is. `behavior`
   * comes from cards.ts (allow / deny / answer), never the button's text.
   */
  async respondToThread(threadId: string, requestId: string, behavior: string, message?: string): Promise<void> {
    const body: Record<string, unknown> = { requestId, behavior }
    if (message !== undefined) body['message'] = message
    await this.post(`/api/threads/${threadId}/respond`, body)
  }

  /** Remember a grant so the same tool stops asking. The harness puts the key on the card; the phone never derives one. */
  async alwaysAllow(botId: string, allowKey: string): Promise<void> {
    await this.post(`/api/bots/${botId}/always-allow`, { allowKey })
  }

  /** Purpose-built read verb — never a general PATCH. */
  async markBotRead(botId: string): Promise<void> {
    await this.post(`/api/bots/${botId}/read`)
  }

  async markRoomRead(groupId: string): Promise<void> {
    await this.post(`/api/groups/${groupId}/read`)
  }

  async interruptBot(botId: string): Promise<void> {
    await this.post(`/api/bots/${botId}/interrupt`)
  }

  /** Make a bot. The harness builds it; the bot frame delivers it to the roster. */
  async createBot(): Promise<Bot> {
    const created = await this.request<{ bot: Bot }>('POST', '/api/bots')
    return created.bot
  }

  /** Make a room. The harness names it after the first member when `name` is empty. */
  async createRoom(name: string | undefined, memberIds: string[]): Promise<Group> {
    const body: Record<string, unknown> = { memberIds }
    if (name && name.trim().length > 0) body['name'] = name
    const created = await this.request<{ group: Group }>('POST', '/api/groups', {}, body)
    return created.group
  }

  // MARK: - Reading (search, export, inventory, media)

  /** Search every transcript. Land on a hit with getThreadPage(around:). */
  async search(query: string, limit = 40): Promise<SearchHit[]> {
    const response = await this.request<{ hits: SearchHit[] }>('GET', '/api/search', { q: query, limit: String(limit) })
    return response.hits
  }

  /**
   * Export one transcript. The filename comes from the server's
   * Content-Disposition when it sends one — parsed the way Client.swift
   * parses it — with the format-based fallback otherwise.
   */
  async exportTranscript(threadId: string, format: string): Promise<TranscriptExport> {
    const { bytes, header } = await this.requestBytes('GET', `/api/threads/${threadId}/export`, { format })
    const disposition = header('Content-Disposition') ?? ''
    const filenamePart = disposition
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.toLowerCase().startsWith('filename='))
    const filename = filenamePart
      ? filenamePart.slice('filename='.length).replace(/^"|"$/g, '')
      : `transcript.${format === 'json' ? 'json' : 'md'}`
    return { data: bytes, filename, contentType: header('Content-Type') ?? 'application/octet-stream' }
  }

  /** The provider instances configured on the computer. */
  async instances(): Promise<Instance[]> {
    const response = await this.request<{ instances: Instance[] }>('GET', '/api/instances')
    return response.instances
  }

  /** What the computer has set up (keys present, TTS ready, the owner's profile). */
  async config(): Promise<ConfigStatus> {
    return this.request<ConfigStatus>('GET', '/api/config')
  }

  /** The connector catalog — what could be connected (not an account list). */
  async connectorCatalog(): Promise<ConnectorCatalog> {
    return this.request<ConnectorCatalog>('GET', '/api/connectors/catalog')
  }

  /** Account-aware connector status in one request — the inventory source. */
  async connectorStatuses(): Promise<ConnectorStatuses> {
    return this.request<ConnectorStatuses>('GET', '/api/connectors/connected')
  }

  /** The pixels of one screen message. */
  async messageImage(threadId: string, messageId: string): Promise<Uint8Array> {
    const { bytes } = await this.requestBytes('GET', `/api/threads/${threadId}/messages/${messageId}/image`)
    return bytes
  }

  /**
   * Fetch an app-owned avatar with the device bearer <redacted> Custom avatars
   * never go through a plain image loader, which cannot attach that token.
   * The path is validated the way shared/bot-avatar.ts validates it: one
   * bare ASCII filename under /api/attachments/, one known extension.
   */
  async avatarData(path: string): Promise<Uint8Array> {
    if (!CompanionClient.validAvatarPath(path)) {
      throw new TransportError("That avatar address doesn't look right.")
    }
    const { bytes } = await this.requestBytes('GET', path)
    return bytes
  }

  static validAvatarPath(path: string): boolean {
    const prefix = '/api/attachments/'
    if (!path.startsWith(prefix)) return false
    const name = path.slice(prefix.length)
    const dot = name.lastIndexOf('.')
    if (dot <= 0) return false
    const stem = name.slice(0, dot)
    const ext = name.slice(dot + 1)
    if (!/^[0-9A-Za-z-]+$/.test(stem)) return false
    return ['png', 'jpg', 'gif', 'webp'].includes(ext)
  }

  /** The voices the computer can speak with. */
  async voices(): Promise<Voice[]> {
    const response = await this.request<{ voices: Voice[] }>('GET', '/api/tts/voices')
    return response.voices
  }

  /** Hear a voice before choosing it (text capped at 500 chars, like iOS). */
  async previewVoice(text: string, voiceId: string): Promise<Uint8Array> {
    const { bytes } = await this.requestBytes(
      'POST',
      '/api/tts/speak',
      {},
      { json: { text: text.slice(0, 500), voiceId } },
    )
    return bytes
  }

  /** Routines and their runs, in one read. */
  async routines(): Promise<{ routines: Routine[]; runs: RoutineRun[] }> {
    return this.request<{ routines: Routine[]; runs: RoutineRun[] }>('GET', '/api/routines')
  }

  // MARK: - Doing (profiles, avatars, routines, connectors, tasks)

  /**
   * Update a bot's profile through the narrow paired-device contract.
   * Absent fields are left alone; avatarUrl clears only via {clear: true}.
   */
  async updateProfile(botId: string, patch: BotProfilePatch): Promise<Bot> {
    const body: Record<string, unknown> = {}
    if (patch.name !== undefined) body['name'] = patch.name
    if (patch.title !== undefined) body['title'] = patch.title
    if (patch.description !== undefined) body['description'] = patch.description
    if (patch.notifications !== undefined) body['notifications'] = patch.notifications
    if (patch.avatarUrl !== undefined) body['avatarUrl'] = 'set' in patch.avatarUrl ? patch.avatarUrl.set : null
    if (patch.avatarCrop !== undefined) body['avatarCrop'] = patch.avatarCrop
    if (patch.voice !== undefined) body['voice'] = patch.voice
    if (patch.speakReplies !== undefined) body['speakReplies'] = patch.speakReplies
    const response = await this.request<{ bot: Bot }>('PATCH', `/api/bots/${botId}/profile`, {}, body)
    return response.bot
  }

  /** Upload an avatar image; returns its /api/attachments/ path. */
  async uploadAvatar(data: Uint8Array, mime: string): Promise<string> {
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
    if (!allowed.includes(mime) || data.length > 10 * 1024 * 1024) {
      throw new TransportError('Choose a PNG, JPEG, GIF, or WebP image up to 10 MB.')
    }
    const { bytes } = await this.requestBytes('POST', '/api/attachments', {}, { rawBody: data, contentType: mime })
    const saved = JSON.parse(new TextDecoder().decode(bytes)) as { path: string }
    const name = saved.path.split('/').pop() ?? ''
    if (!name || name.includes('/')) {
      throw new TransportError('The uploaded image could not be used.')
    }
    return `/api/attachments/${name}`
  }

  /**
   * Generate an avatar from a prompt (capped at 400 chars). The server
   * gives its image provider 120 seconds, so this call's timeout is 150 —
   * room for the server's own bounded timeout error to arrive instead.
   */
  async generateAvatar(botId: string, prompt: string): Promise<Bot> {
    const response = await this.request<{ bot: Bot }>(
      'POST',
      `/api/bots/${botId}/avatar/generate`,
      {},
      { prompt: prompt.slice(0, 400) },
      true,
      150_000,
    )
    return response.bot
  }

  private static routineBody(input: RoutineInput): Record<string, unknown> {
    const schedule: Record<string, unknown> = { type: input.schedule.type }
    if (input.schedule.at !== undefined) schedule['at'] = input.schedule.at
    if (input.schedule.time !== undefined) schedule['time'] = input.schedule.time
    if (input.schedule.weekdays !== undefined) schedule['weekdays'] = input.schedule.weekdays
    const body: Record<string, unknown> = {
      name: input.name,
      prompt: input.prompt,
      botId: input.botId,
      runOn: input.runOn,
      schedule,
      durationMinutes: input.durationMinutes,
    }
    if (input.enabled !== undefined) body['enabled'] = input.enabled
    return body
  }

  private static assertRoutineSaveable(input: RoutineInput): void {
    if (input.schedule.type === 'unknown') {
      throw new TransportError('Choose a supported schedule before saving this routine.')
    }
  }

  async createRoutine(input: RoutineInput): Promise<Routine> {
    CompanionClient.assertRoutineSaveable(input)
    const response = await this.request<{ routine: Routine }>(
      'POST',
      '/api/routines',
      {},
      CompanionClient.routineBody(input),
    )
    return response.routine
  }

  async updateRoutine(id: string, input: RoutineInput): Promise<Routine> {
    CompanionClient.assertRoutineSaveable(input)
    const response = await this.request<{ routine: Routine }>(
      'PATCH',
      `/api/routines/${id}`,
      {},
      CompanionClient.routineBody(input),
    )
    return response.routine
  }

  async setRoutineEnabled(id: string, enabled: boolean): Promise<Routine> {
    const response = await this.request<{ routine: Routine }>('PATCH', `/api/routines/${id}`, {}, { enabled })
    return response.routine
  }

  async runRoutine(id: string): Promise<RoutineRun> {
    const response = await this.request<{ run: RoutineRun }>('POST', `/api/routines/${id}/run`)
    return response.run
  }

  async deleteRoutine(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `/api/routines/${id}`, {}, undefined, false)
  }

  /**
   * Start one more account authorization for a toolkit; returns the https
   * URL to open. Revocation is intentionally absent: the paired-device
   * boundary keeps that on the computer.
   */
  async authorizeConnector(slug: string, alias?: string): Promise<string> {
    if (!/^[0-9A-Za-z_-]+$/.test(slug)) {
      throw new TransportError("That connector name doesn't look right.")
    }
    const trimmed = alias?.trim()
    const body = trimmed ? { alias: trimmed } : undefined
    const response = await this.request<{ url: string }>('POST', `/api/connectors/${slug}/authorize`, {}, body)
    let parsed: URL
    try {
      parsed = new URL(response.url)
    } catch {
      throw new TransportError("The computer sent an address this app can't open.")
    }
    if (parsed.protocol !== 'https:' || !parsed.host) {
      throw new TransportError("The computer sent an address this app can't open.")
    }
    return response.url
  }

  /** Toggle my reaction on a message; the updated message comes back. */
  async toggleReaction(threadId: string, messageId: string, emoji: string): Promise<Message> {
    const response = await this.request<{ message: Message }>(
      'POST',
      `/api/threads/${threadId}/messages/${messageId}/reactions`,
      {},
      { emoji },
    )
    return response.message
  }

  /** Edit one of my sent messages in a bot's thread. */
  async editMessage(botId: string, messageId: string, text: string): Promise<void> {
    await this.post(`/api/bots/${botId}/messages/${messageId}/edit`, { text })
  }

  /** Switch the thread's active branch to the one ending at a message. */
  async setActiveBranch(botId: string, messageId: string): Promise<string> {
    const response = await this.request<{ activeLeafId: string }>(
      'POST',
      `/api/bots/${botId}/active-branch`,
      {},
      { messageId },
    )
    return response.activeLeafId
  }

  /** Start a new task (thread) for a bot. */
  async createTask(botId: string, title?: string): Promise<Bot> {
    const body: Record<string, unknown> = {}
    if (title) body['title'] = title
    const response = await this.request<{ bot: Bot }>('POST', `/api/bots/${botId}/tasks`, {}, body)
    return response.bot
  }

  async switchTask(botId: string, threadId: string): Promise<Bot> {
    const response = await this.request<{ bot: Bot }>('POST', `/api/bots/${botId}/tasks/${threadId}`)
    return response.bot
  }

  async renameTask(botId: string, threadId: string, title: string): Promise<void> {
    await this.request<unknown>('PATCH', `/api/bots/${botId}/tasks/${threadId}`, {}, { title }, false)
  }

  async deleteTask(botId: string, threadId: string): Promise<Bot> {
    const response = await this.request<{ bot: Bot }>('DELETE', `/api/bots/${botId}/tasks/${threadId}`)
    return response.bot
  }

  /**
   * Mint a fresh interactive viewer for an existing cloud computer. The
   * response URL is a bearer credential: present it directly, never store
   * it. The sidecar additionally requires this device's cloud-desktop
   * capability to be enabled on the computer.
   */
  async cloudDesktop(botId: string): Promise<CloudDesktopSession> {
    const response = await this.request<{ joinUrl: string }>('POST', `/api/bots/${botId}/computer/join`)
    let parsed: URL
    try {
      parsed = new URL(response.joinUrl)
    } catch {
      throw new TransportError("The computer sent an address this app can't open.")
    }
    if (parsed.protocol !== 'https:' || !parsed.host) {
      throw new TransportError("The computer sent an address this app can't open.")
    }
    return { url: response.joinUrl }
  }

  /**
   * The event stream URL: GET /api/events with `screens=off` (the harness
   * pushes a base64 desktop capture every few seconds to every client that
   * asks — a poor thing to send a phone on cellular) and `since=<cursor>`
   * when resuming. The stream request needs a 90s IDLE timeout: the harness
   * sends a keepalive comment every 25s, already past the 20s API deadline —
   * whoever opens this URL must not reuse the API timeout (the iOS client
   * learned that the hard way: quiet streams reconnect-looped forever).
   */
  eventsUrl(cursor: string | null): string {
    const base = baseUrl(this.connection)
    if (!base) throw new TransportError("That address doesn't look right.")
    const params = new URLSearchParams({ screens: 'off' })
    if (cursor) params.set('since', cursor)
    return `${base}/api/events?${params.toString()}`
  }

  /** Authorization header for the stream request (it is not a fetch through this client). */
  get streamHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    return headers
  }
}
