/**
 * CompanionCore wire types — a TypeScript port of the iOS app's
 * `Sources/CompanionCore/Models.swift`, shaped by the captured fixtures in
 * `./fixtures/` (which came from a real harness — see the iOS repo's
 * `scripts/capture-companion-fixtures.mjs`).
 *
 * Rule from the iOS codebase: the phone is a thin client. These types are the
 * harness's wire contract, not a local invention. Unknown fields are tolerated
 * on decode; unknown frame kinds are absorbed (see `./sse.ts`).
 */

export interface ModelSelection {
  instanceId: string
  model: string
}

export interface BotTask {
  threadId: string
  title: string
  createdAt: number
}

export interface MessageCard {
  title: string
  subtitle?: string
  options: string[]
  /** The chosen option once answered (wire field on OptionCard). */
  answered?: string
  dismissed?: boolean
  /** Present when this card is a live provider ask — what makes it answerable rather than historical. */
  requestId?: string
  /** The tool asking. Permission cards carry one; questions do not. */
  tool?: string
  /** Why auto mode stopped to ask anyway. */
  held?: string
  /** The narrow grant "always allow" would remember, e.g. `Bash:git`. The phone never derives its own. */
  allowKey?: string
  [key: string]: unknown
}

export interface Message {
  id: string
  /** Epoch milliseconds. */
  at: number
  parentId: string | null
  role: 'user' | 'bot' | string
  kind: 'text' | 'options' | 'activity' | string
  text?: string
  card?: MessageCard
  /** Tool activity on `activity` messages — its failure is a mascot state. */
  tool?: { name: string; ok?: boolean | null; spoken?: string } | null
  [key: string]: unknown
}

export interface Bot {
  id: string
  threadId: string
  name: string
  title: string
  description: string
  notifications: boolean
  /** ClawdPalette colour name — the same bot is the same colour on every screen. */
  color: string
  unread: boolean
  /** A pinned mascot expression (a ClawdState name or a legacy alias). */
  mascotExpression?: string
  /** The harness's busy flag — the "working" signal for the roster and activities. */
  busy?: boolean
  pinned?: boolean
  hidden?: boolean
  chiefOfStaff?: boolean
  modelSelection: ModelSelection
  createdAt: number
  tasks: BotTask[]
  messages?: Message[]
  activeLeafId?: string
  hasMore?: boolean
  avatarUrl?: string
  avatarCrop?: string
  speakReplies?: boolean
  voice?: string
  [key: string]: unknown
}

export interface Group {
  id: string
  threadId: string
  name: string
  memberIds: string[]
  defaultResponder: { kind: string; [key: string]: unknown }
  bulletin: string
  unread: boolean
  createdAt: number
  busyBotId: string | null
  messages?: Message[]
  hasMore?: boolean
  [key: string]: unknown
}

/** One search result (GET /api/search unwraps `.hits`). */
export interface SearchHit {
  threadId: string
  messageId: string
  at: number
  role: string
  kind: string
  snippet: string
  matchStart: number
  matchLength: number
  botId?: string
  groupId?: string
  name: string
  task?: string
  onActivePath: boolean
  [key: string]: unknown
}

/** A transcript export: raw bytes plus the server's filename and type. */
export interface TranscriptExport {
  data: Uint8Array
  filename: string
  contentType: string
}

/** A provider instance on the computer (GET /api/instances unwraps `.instances`). */
export interface Instance {
  instanceId: string
  driverKind: string
  displayName?: string
  snapshot: { state: string; reason?: string; [key: string]: unknown }
  models: { default: string; options: unknown[]; [key: string]: unknown }
  [key: string]: unknown
}

export interface ConfigFlag {
  configured: boolean
  apiKeyConfigured?: boolean
  ready?: boolean
  voice?: string
}

/** GET /api/config — what the computer has set up (fixture: config.json). */
export interface ConfigStatus {
  composio?: ConfigFlag
  box?: ConfigFlag
  tts?: ConfigFlag
  imageGen?: ConfigFlag
  profile?: { name: string; email: string }
  [key: string]: unknown
}

export interface ConnectorCard {
  slug: string
  label: string
  blurb: string
  logo?: string
  domain?: string
}

export interface ConnectorAccount {
  id: string
  alias?: string
  status: string
}

export interface ConnectorStatus {
  connected: boolean
  pending?: boolean
  status?: string
  accounts?: ConnectorAccount[]
}

export interface ConnectorCatalog {
  configured: boolean
  mode?: string
  source?: string
  cards: ConnectorCard[]
}

export interface ConnectorStatuses {
  configured: boolean
  services: Record<string, ConnectorStatus>
}

/** A TTS voice the computer can speak with. */
export interface Voice {
  id: string
  label: string
  description?: string
}

export interface RoutineSchedule {
  /** 'once' | 'daily' — anything newer decodes as 'unknown' and cannot be saved from the phone. */
  type: 'once' | 'daily' | 'unknown' | string
  at?: number
  time?: string
  weekdays?: number[]
}

export interface Routine {
  id: string
  name: string
  prompt: string
  botId: string
  runOn: string
  enabled: boolean
  schedule: RoutineSchedule
  durationMinutes: number
  nextRunAt?: number
  createdAt: number
  updatedAt: number
  [key: string]: unknown
}

export interface RoutineRun {
  id: string
  routineId: string
  routineName: string
  prompt?: string
  durationMinutes?: number
  botId: string
  runOn: string
  scheduledFor: number
  status: string
  manual: boolean
  triggerSource?: string
  threadId?: string
  startedAt?: number
  finishedAt?: number
  output?: string
  error?: string
  createdAt: number
  seenAt?: number
  [key: string]: unknown
}

export interface RoutineInput {
  name: string
  prompt: string
  botId: string
  runOn: string
  enabled?: boolean
  schedule: RoutineSchedule
  durationMinutes: number
}

/** Setting an avatar is a path; clearing one is an explicit null — absence leaves it alone. */
export type AvatarUrlPatch = { set: string } | { clear: true }

/**
 * The paired-device profile contract — deliberately narrower than the
 * desktop's general bot PATCH. No execution policy or provider secret can
 * be reached through it.
 */
export interface BotProfilePatch {
  name?: string
  title?: string
  description?: string
  notifications?: boolean
  avatarUrl?: AvatarUrlPatch
  avatarCrop?: 'mascot' | 'circle' | 'rounded' | 'square' | string
  voice?: string
  speakReplies?: boolean
}

/**
 * A freshly minted cloud-desktop viewer. The URL is a short-lived bearer
 * credential: present it directly, never store it.
 */
export interface CloudDesktopSession {
  url: string
}

/** Response of the bots/roster read (fixtures: bots-full, bots-paged). */
export interface BotsResponse {
  bots: Bot[]
  groups: Group[]
}

/** A page of one thread's transcript (fixture: thread-page). */
export interface ThreadPage {
  messages: Message[]
  hasMore: boolean
}

/** Pairing exchange result (fixture: pair-response; token value is redacted there). */
export interface PairResponse {
  token: string
  device: { id: string; name: string; createdAt: number; lastSeenAt: number }
  serverName: string
  /** Every address the computer answers on, best first. Absent from older sidecars. */
  hosts?: string[]
  /** Full routes from newer sidecars. Advisory only — a response cannot widen invite consent. */
  endpoints?: import('./endpoint').CompanionEndpoint[]
}

/** Authenticated route refresh (GET /api/companion/endpoints). No credentials in it. */
export interface CompanionConnectionMetadata {
  serverName: string
  hosts?: string[]
  endpoints: import('./endpoint').CompanionEndpoint[]
}

/**
 * SSE frames from the companion stream. The iOS `Frames.swift` absorbs unknown
 * kinds rather than failing — the stream must never die because the harness
 * learned a new frame.
 */
export type Frame =
  | { kind: 'hello'; cursor: string; resumed: boolean }
  | { kind: 'message'; threadId: string; message: Message; seq?: number }
  | { kind: 'message.patch'; threadId: string; messageId: string; patch: Record<string, unknown>; seq?: number }
  | { kind: 'bot'; bot: Bot; seq?: number }
  | { kind: 'runtime'; threadId: string; delta: Record<string, unknown>; seq?: number }
  | { kind: string; [key: string]: unknown }

/**
 * The Live Activity contract from iOS `Shared/BotActivity.swift`, carried to
 * Android as the data behind the ongoing notification (there are no Live
 * Activities on Android). One entry per bot that is doing something — quiet
 * bots have none, the same rule as the Updates pill.
 */
export interface BotActivity {
  botId: string
  threadId: string
  name: string
  /** ClawdPalette colour name. */
  color: string
  state: {
    /** ClawdState raw value — the face to wear. */
    face: string
    kind: 'needsYou' | 'working' | 'toReview'
    headline: string
    line: string
    requestId?: string
    options: string[]
    /** A permission card answers allow/deny; a question answers with text. */
    isPermission: boolean
    /** When this kind began (epoch ms) — timers count from it. */
    since: number
  }
}
