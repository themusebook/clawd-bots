import type { ConfigStatus, Instance, Routine } from './models'

/**
 * Routine presentation + policy helpers — the rules Models.swift states:
 *
 * - canToggle mirrors the desktop `canToggleRoutine` policy: a daily
 *   routine can always be toggled; a one-time routine only while its
 *   instant is still ahead (a past one-shot has no meaningful Resume);
 *   an unknown schedule — one a newer desktop introduced — can never be
 *   toggled or saved from the phone until a supported kind is chosen.
 * - Run location: 'clawd' (this computer) or 'cloud'. Cloud is selectable
 *   only when it is ready (Box configured AND an available boxAgent
 *   instance) — except when preserving a routine that already runs there,
 *   so editing never silently moves a routine whose VM is briefly away.
 */

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Weekday numbers follow the harness's JS convention: 0 = Sunday … 6 = Saturday. */
export function canToggleRoutine(routine: Routine, now: number = Date.now()): boolean {
  switch (routine.schedule.type) {
    case 'daily':
      return true
    case 'once':
      return (routine.schedule.at ?? Number.NEGATIVE_INFINITY) > now
    default:
      return false
  }
}

export function scheduleSummary(routine: Routine): string {
  const schedule = routine.schedule
  if (schedule.type === 'once') {
    return schedule.at ? `Once · ${new Date(schedule.at).toLocaleString()}` : 'Once'
  }
  if (schedule.type === 'daily') {
    const days = (schedule.weekdays ?? []).map((day) => WEEKDAY_LABELS[day] ?? String(day)).join(' ')
    return `Daily · ${schedule.time ?? ''}${days ? ` · ${days}` : ''}`
  }
  return 'Scheduled (newer format)'
}

export interface RunAvailability {
  cloudConfigured: boolean
  cloudInstanceAvailable: boolean
  cloudReady: boolean
}

export function runAvailability(config: ConfigStatus | null, instances: Instance[]): RunAvailability {
  const cloudConfigured = config?.box?.configured === true
  // ProviderSnapshot.isAvailable on iOS is computed: state == "available".
  const cloudInstanceAvailable = instances.some(
    (instance) => instance.driverKind === 'boxAgent' && instance.snapshot.state === 'available',
  )
  return { cloudConfigured, cloudInstanceAvailable, cloudReady: cloudConfigured && cloudInstanceAvailable }
}

/** Whether a run location may be selected in the editor (see header). */
export function canSelectLocation(availability: RunAvailability, location: string, current: string): boolean {
  return location === 'clawd' || availability.cloudReady || current === 'cloud'
}
