import * as Notifications from 'expo-notifications'

import { activitySignature, planNotificationSync } from '@/companion-core/activity'
import type { BotActivity } from '@/companion-core/models'

/**
 * The Android surface for BotActivity: one ongoing (sticky) notification per
 * active bot — the counterpart of the iOS Live Activity. Needs-you
 * notifications carry the card's options as action buttons (a per-request
 * notification category, since the options are the card's own); tapping the
 * body opens the thread. The sync policy itself is pure
 * (companion-core/activity.ts) — this class only performs it.
 *
 * Answers from a notification run in the app process, like the iOS
 * LiveActivityIntent handler: the provider routes them to
 * LiveSession.answerByRequest.
 */

export const ACTIVITY_CHANNEL_ID = 'bot-activity'

export function activityNotificationId(botId: string): string {
  return `activity-${botId}`
}

export function activityCategoryId(requestId: string): string {
  return `needs-you-${requestId}`
}

export interface ActivityNotificationData {
  botId: string
  threadId: string
  requestId?: string
  isPermission?: boolean
}

let handlerInstalled = false

/** Foreground presentation: the app already shows this state in its own UI. */
export function installNotificationHandler(): void {
  if (handlerInstalled) return
  handlerInstalled = true
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  })
}

export async function ensureActivityChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync(ACTIVITY_CHANNEL_ID, {
    name: 'Bot activity',
    description: 'A bot that needs you, is working, or has an update to review.',
    importance: Notifications.AndroidImportance.HIGH,
  })
}

export async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync()
  if (current.granted) return true
  const requested = await Notifications.requestPermissionsAsync()
  return requested.granted
}

export class ActivityNotificationSync {
  private presented = new Map<string, string>()
  private categories = new Set<string>()

  async sync(allActivities: BotActivity[]): Promise<void> {
    // Like the iOS Live Activity coordinator: toReview is for the roster
    // pill and the badge, not for a surface that interrupts — the ongoing
    // notifications carry needsYou and working only.
    const activities = allActivities.filter((activity) => activity.state.kind !== 'toReview')
    const plan = planNotificationSync(activities, this.presented)
    for (const botId of plan.dismissBotIds) {
      await Notifications.dismissNotificationAsync(activityNotificationId(botId))
      this.presented.delete(botId)
    }
    for (const activity of plan.present) {
      await this.present(activity)
      this.presented.set(activity.botId, activitySignature(activity))
    }
  }

  async clearAll(): Promise<void> {
    for (const botId of [...this.presented.keys()]) {
      await Notifications.dismissNotificationAsync(activityNotificationId(botId))
    }
    this.presented.clear()
    for (const categoryId of this.categories) {
      await Notifications.deleteNotificationCategoryAsync(categoryId)
    }
    this.categories.clear()
  }

  private async present(activity: BotActivity): Promise<void> {
    const { state } = activity
    let categoryIdentifier: string | undefined
    if (state.kind === 'needsYou' && state.requestId) {
      categoryIdentifier = activityCategoryId(state.requestId)
      if (!this.categories.has(categoryIdentifier)) {
        await Notifications.setNotificationCategoryAsync(
          categoryIdentifier,
          state.options.map((option) => ({
            identifier: option,
            buttonTitle: option,
            options: { opensAppToForeground: false },
          })),
        )
        this.categories.add(categoryIdentifier)
      }
    }
    const data: ActivityNotificationData = {
      botId: activity.botId,
      threadId: activity.threadId,
      requestId: state.requestId,
      isPermission: state.isPermission,
    }
    await Notifications.scheduleNotificationAsync({
      identifier: activityNotificationId(activity.botId),
      content: {
        title: state.headline,
        body: state.line,
        data: { ...data },
        categoryIdentifier,
        sticky: state.kind !== 'toReview',
      },
      trigger: null,
    })
  }
}
