import { isPendingCard } from './cards'
import { clawdStateForBot } from './mascot'
import type { BotActivity } from './models'
import type { CompanionState } from './store'

/**
 * BotActivity derivation — the Android counterpart of the iOS Live Activity
 * contract (Shared/BotActivity.swift): one activity per bot that is doing
 * something — needs you, or working — plus finished work waiting to be read.
 * Quiet bots have no activity, the same rule as the Updates pill. Bots only:
 * the contract is keyed by bot, so rooms never appear here.
 *
 * Priority is needsYou > working > toReview, one per bot. A bot whose
 * `notifications` flag is off, or that is hidden, never appears.
 */
export function deriveActivities(state: CompanionState): BotActivity[] {
  const activities: BotActivity[] = []
  for (const bot of state.bots) {
    if (bot.hidden === true || bot.notifications === false) continue
    const messages = state.messagesByThread[bot.threadId] ?? []
    const last = messages.length ? messages[messages.length - 1] : undefined

    const face = clawdStateForBot(bot, last)
    const pendingMessage = [...messages].reverse().find((message) => message.card && isPendingCard(message.card))
    if (pendingMessage?.card) {
      const card = pendingMessage.card
      activities.push({
        botId: bot.id,
        threadId: bot.threadId,
        name: bot.name,
        color: bot.color,
        state: {
          face,
          kind: 'needsYou',
          headline: `${bot.name} needs you`,
          // The updates rule: the card's subtitle explains, its title asks;
          // an empty line falls back to the title (LiveActivities.swift).
          line: (card.subtitle ?? card.title) || card.title,
          requestId: card.requestId ?? undefined,
          options: card.options,
          isPermission: card.tool != null,
          since: pendingMessage.at,
        },
      })
      continue
    }

    if (bot.busy === true) {
      activities.push({
        botId: bot.id,
        threadId: bot.threadId,
        name: bot.name,
        color: bot.color,
        state: {
          face,
          kind: 'working',
          headline: `${bot.name} is working`,
          line: last?.text ?? last?.card?.title ?? bot.title,
          options: [],
          isPermission: false,
          since: last?.at ?? bot.createdAt,
        },
      })
      continue
    }

    if (bot.unread && last) {
      activities.push({
        botId: bot.id,
        threadId: bot.threadId,
        name: bot.name,
        color: bot.color,
        state: {
          face,
          kind: 'toReview',
          headline: `${bot.name} has an update`,
          line: last.text ?? last.card?.title ?? bot.title,
          options: [],
          isPermission: false,
          since: last.at,
        },
      })
    }
  }
  // Needs-you first, then most recent — the order a lock screen should read.
  const kindRank = { needsYou: 0, working: 1, toReview: 2 } as const
  return activities.sort((a, b) => kindRank[a.state.kind] - kindRank[b.state.kind] || b.state.since - a.state.since)
}

/** What a presented notification currently says — change means re-present. */
export function activitySignature(activity: BotActivity): string {
  const s = activity.state
  return [s.kind, s.requestId ?? '', s.headline, s.line, s.options.join()].join('|')
}

export interface NotificationSyncPlan {
  present: BotActivity[]
  dismissBotIds: string[]
}

/**
 * Diff the activities that should be on screen against the ones that are —
 * the whole sync policy, kept pure so it is testable without a device.
 * `presented` maps botId → activitySignature of what is currently shown.
 */
export function planNotificationSync(
  activities: BotActivity[],
  presented: ReadonlyMap<string, string>,
): NotificationSyncPlan {
  const present: BotActivity[] = []
  const wanted = new Set<string>()
  for (const activity of activities) {
    wanted.add(activity.botId)
    if (presented.get(activity.botId) !== activitySignature(activity)) present.push(activity)
  }
  const dismissBotIds = [...presented.keys()].filter((botId) => !wanted.has(botId))
  return { present, dismissBotIds }
}
