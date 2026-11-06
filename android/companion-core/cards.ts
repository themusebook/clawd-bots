/**
 * Option-card rules — port of iOS `OptionCard` (Models.swift).
 *
 * A card is actionable while it is unanswered and still has a request behind
 * it; everything else is transcript. The wire accepts an approval *behavior*
 * rather than the button's display text: treat the one refusal as deny and
 * every other offered permission choice as allow — providers may say
 * "Approve", "Yes", or "Always allow", and none of those should accidentally
 * become a deny.
 */

import type { MessageCard } from './models'

export function isPendingCard(card: MessageCard): boolean {
  return card.requestId != null && card.answered == null && card.dismissed !== true
}

/** Permission cards carry a tool; questions do not. */
export function isPermissionCard(card: MessageCard): boolean {
  return card.tool != null
}

export function isRefusalChoice(choice: string): boolean {
  return choice.trim().toLowerCase() === 'deny'
}

/** The behavior the respond verb takes for a tapped option. */
export function responseBehaviorFor(choice: string, isPermission: boolean): string {
  if (!isPermission) return 'answer'
  return isRefusalChoice(choice) ? 'deny' : 'allow'
}

export function cardResponseBehavior(card: MessageCard, choice: string): string {
  return responseBehaviorFor(choice, isPermissionCard(card))
}

/**
 * "Always allow" is remembered before the answer goes out: the grant key
 * comes from the card (the phone never derives one), and only the exact
 * "Always allow" choice on a permission card that carries a key counts.
 */
export function shouldRememberPermission(card: MessageCard, choice: string): boolean {
  if (!isPermissionCard(card) || !card.allowKey) return false
  return choice.trim().toLowerCase() === 'always allow'
}
