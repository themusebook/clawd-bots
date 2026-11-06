import React, { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'

import { AppActionButton } from '@/components/app-action-button'
import type { Routine, RoutineInput, RoutineRun } from '@/companion-core/models'
import {
  canSelectLocation,
  canToggleRoutine,
  runAvailability,
  scheduleSummary,
  WEEKDAY_LABELS,
  type RunAvailability,
} from '@/companion-core/routines'
import { appStyles } from '@/constants/app-styles'
import { useCompanion } from '@/features/companion/companion-provider'

/**
 * Routines — scheduled bot runs, run from the phone. The list, the runs,
 * and every action read and write through the client; nothing is staged
 * optimistically (a toggle flips when the harness's answer lands, and the
 * list refetches). Policy mirrors the desktop: canToggleRoutine decides
 * whether the switch is live at all, and the cloud run location is only
 * offered when RoutineRunAvailability says it is ready — or when the
 * routine already lives there.
 */

interface FormState {
  name: string
  prompt: string
  botId: string
  runOn: string
  schedType: 'once' | 'daily'
  onceDate: string
  onceTime: string
  dailyTime: string
  weekdays: number[]
  duration: string
  enabled: boolean
}

function formFromRoutine(routine: Routine): FormState {
  const at = routine.schedule.at ? new Date(routine.schedule.at) : new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    name: routine.name,
    prompt: routine.prompt,
    botId: routine.botId,
    runOn: routine.runOn,
    schedType: routine.schedule.type === 'once' ? 'once' : 'daily',
    onceDate: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    onceTime: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
    dailyTime: routine.schedule.time ?? '09:00',
    weekdays: routine.schedule.weekdays ?? [0, 1, 2, 3, 4, 5, 6],
    duration: String(routine.durationMinutes),
    enabled: routine.enabled,
  }
}

function emptyForm(botId: string): FormState {
  const at = new Date(Date.now() + 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    name: '',
    prompt: '',
    botId,
    runOn: 'clawd',
    schedType: 'daily',
    onceDate: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    onceTime: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
    dailyTime: '09:00',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    duration: '30',
    enabled: true,
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function buildInput(form: FormState): { input?: RoutineInput; error?: string } {
  if (!form.name.trim()) return { error: 'Give the routine a name.' }
  if (!form.prompt.trim()) return { error: 'Write the prompt the bot should run.' }
  if (!form.botId) return { error: 'Choose which bot runs it.' }
  const durationMinutes = Number.parseInt(form.duration, 10)
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0)
    return { error: 'Duration must be a positive number of minutes.' }
  if (form.schedType === 'once') {
    if (!TIME_PATTERN.test(form.onceTime)) return { error: 'Use a 24-hour time like 14:30.' }
    const at = new Date(`${form.onceDate}T${form.onceTime}:00`).getTime()
    if (!Number.isFinite(at)) return { error: 'That date does not parse — use YYYY-MM-DD.' }
    return {
      input: {
        name: form.name.trim(),
        prompt: form.prompt,
        botId: form.botId,
        runOn: form.runOn,
        enabled: form.enabled,
        schedule: { type: 'once', at },
        durationMinutes,
      },
    }
  }
  if (!TIME_PATTERN.test(form.dailyTime)) return { error: 'Use a 24-hour time like 09:00.' }
  if (form.weekdays.length === 0) return { error: 'Pick at least one weekday.' }
  return {
    input: {
      name: form.name.trim(),
      prompt: form.prompt,
      botId: form.botId,
      runOn: form.runOn,
      enabled: form.enabled,
      schedule: { type: 'daily', time: form.dailyTime, weekdays: [...form.weekdays].sort((a, b) => a - b) },
      durationMinutes,
    },
  }
}

export function RoutinesFeature() {
  const { session, ready } = useCompanion()
  const [routines, setRoutines] = useState<Routine[]>([])
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [availability, setAvailability] = useState<RunAvailability>({
    cloudConfigured: false,
    cloudInstanceAvailable: false,
    cloudReady: false,
  })
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string | null; form: FormState } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!session) return
    try {
      const [data, config, instances] = await Promise.all([
        session.routines(),
        session.configStatus().catch(() => null),
        session.instances().catch(() => []),
      ])
      setRoutines(data.routines)
      setRuns(data.runs)
      setAvailability(runAvailability(config, instances))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Routines could not be loaded.')
    } finally {
      setLoaded(true)
    }
  }, [session])

  useEffect(() => {
    void load()
  }, [load])

  if (!ready) return <Text>Loading…</Text>
  if (!session) return <Text>Pair with your computer first — routines live on it.</Text>
  if (session.status === 'revoked') {
    return <Text>This device was revoked on the computer. Pair again from the home screen to manage routines.</Text>
  }

  const bots = session.state.bots
  const botName = (botId: string) => bots.find((bot) => bot.id === botId)?.name ?? 'A bot'
  const recentRuns = [...runs].sort((a, b) => b.scheduledFor - a.scheduledFor).slice(0, 8)

  const act = async (action: () => Promise<unknown>) => {
    try {
      await action()
      setConfirmDeleteId(null)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not go through.')
    }
  }

  const saveForm = async () => {
    if (!editing) return
    const { input, error: problem } = buildInput(editing.form)
    if (!input) {
      setFormError(problem ?? 'Check the form.')
      return
    }
    try {
      if (editing.id) await session.updateRoutine(editing.id, input)
      else await session.createRoutine(input)
      setEditing(null)
      setFormError(null)
      await load()
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : 'The routine could not be saved.')
    }
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 12 }}>
      {error ? <Text style={appStyles.textDanger}>{error}</Text> : null}
      {!loaded ? <Text>Loading routines…</Text> : null}
      {loaded && routines.length === 0 && !editing ? <Text>No routines yet. Make one below.</Text> : null}

      {routines.map((routine) => (
        <View key={routine.id} style={appStyles.card}>
          <View style={appStyles.stack}>
            <Text style={{ fontWeight: 'bold' }}>{routine.name}</Text>
            <Text>
              {botName(routine.botId)} · {scheduleSummary(routine)} · runs on{' '}
              {routine.runOn === 'cloud' ? 'Cloud' : 'this computer'}
            </Text>
            <Text numberOfLines={2}>{routine.prompt}</Text>
            {routine.nextRunAt ? <Text>Next: {new Date(routine.nextRunAt).toLocaleString()}</Text> : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Switch
                value={routine.enabled}
                disabled={!canToggleRoutine(routine)}
                onValueChange={(enabled) => void act(() => session.setRoutineEnabled(routine.id, enabled))}
              />
              <Text>{routine.enabled ? 'On' : 'Off'}</Text>
              {!canToggleRoutine(routine) ? <Text>(schedule locked)</Text> : null}
            </View>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <AppActionButton title="Run now" onPress={() => act(() => session.runRoutine(routine.id))} />
              <AppActionButton
                title="Edit"
                onPress={async () => setEditing({ id: routine.id, form: formFromRoutine(routine) })}
              />
              {confirmDeleteId === routine.id ? (
                <AppActionButton
                  title="Tap again to delete"
                  onPress={() => act(() => session.deleteRoutine(routine.id))}
                />
              ) : (
                <AppActionButton title="Delete" onPress={async () => setConfirmDeleteId(routine.id)} />
              )}
            </View>
          </View>
        </View>
      ))}

      {editing ? (
        <View style={appStyles.card}>
          <View style={appStyles.stack}>
            <Text style={{ fontWeight: 'bold' }}>{editing.id ? 'Edit routine' : 'New routine'}</Text>
            <TextInput
              style={localStyles.input}
              placeholder="Name"
              value={editing.form.name}
              onChangeText={(name) => setEditing({ ...editing, form: { ...editing.form, name } })}
            />
            <TextInput
              style={localStyles.input}
              placeholder="Prompt — what the bot should do"
              value={editing.form.prompt}
              onChangeText={(prompt) => setEditing({ ...editing, form: { ...editing.form, prompt } })}
              multiline
            />
            <Text>Bot</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {bots.map((bot) => (
                <Pressable
                  key={bot.id}
                  onPress={() => setEditing({ ...editing, form: { ...editing.form, botId: bot.id } })}
                >
                  <Text style={editing.form.botId === bot.id ? localStyles.chipOn : localStyles.chip}>{bot.name}</Text>
                </Pressable>
              ))}
            </View>
            <Text>Runs on</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {(['clawd', 'cloud'] as const).map((location) => {
                const selectable = canSelectLocation(
                  availability,
                  location,
                  editing.id ? (routines.find((r) => r.id === editing.id)?.runOn ?? 'clawd') : 'clawd',
                )
                return (
                  <Pressable
                    key={location}
                    disabled={!selectable}
                    onPress={() => setEditing({ ...editing, form: { ...editing.form, runOn: location } })}
                  >
                    <Text
                      style={[
                        editing.form.runOn === location ? localStyles.chipOn : localStyles.chip,
                        !selectable ? localStyles.chipOff : undefined,
                      ]}
                    >
                      {location === 'clawd' ? 'This computer' : 'Cloud'}
                      {!selectable ? ' (not ready)' : ''}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
            <Text>Schedule</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {(['daily', 'once'] as const).map((type) => (
                <Pressable
                  key={type}
                  onPress={() => setEditing({ ...editing, form: { ...editing.form, schedType: type } })}
                >
                  <Text style={editing.form.schedType === type ? localStyles.chipOn : localStyles.chip}>
                    {type === 'daily' ? 'Daily' : 'Once'}
                  </Text>
                </Pressable>
              ))}
            </View>
            {editing.form.schedType === 'daily' ? (
              <>
                <TextInput
                  style={localStyles.input}
                  placeholder="Time (HH:MM, 24h)"
                  value={editing.form.dailyTime}
                  onChangeText={(dailyTime) => setEditing({ ...editing, form: { ...editing.form, dailyTime } })}
                />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {WEEKDAY_LABELS.map((label, day) => {
                    const on = editing.form.weekdays.includes(day)
                    return (
                      <Pressable
                        key={label}
                        onPress={() =>
                          setEditing({
                            ...editing,
                            form: {
                              ...editing.form,
                              weekdays: on
                                ? editing.form.weekdays.filter((d) => d !== day)
                                : [...editing.form.weekdays, day],
                            },
                          })
                        }
                      >
                        <Text style={on ? localStyles.chipOn : localStyles.chip}>{label}</Text>
                      </Pressable>
                    )
                  })}
                </View>
              </>
            ) : (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TextInput
                  style={[localStyles.input, { flex: 1 }]}
                  placeholder="YYYY-MM-DD"
                  value={editing.form.onceDate}
                  onChangeText={(onceDate) => setEditing({ ...editing, form: { ...editing.form, onceDate } })}
                />
                <TextInput
                  style={[localStyles.input, { flex: 1 }]}
                  placeholder="HH:MM"
                  value={editing.form.onceTime}
                  onChangeText={(onceTime) => setEditing({ ...editing, form: { ...editing.form, onceTime } })}
                />
              </View>
            )}
            <TextInput
              style={localStyles.input}
              placeholder="Duration (minutes)"
              keyboardType="number-pad"
              value={editing.form.duration}
              onChangeText={(duration) => setEditing({ ...editing, form: { ...editing.form, duration } })}
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Switch
                value={editing.form.enabled}
                disabled={(() => {
                  const current = editing.id ? routines.find((r) => r.id === editing.id) : undefined
                  return current ? !canToggleRoutine(current) : false
                })()}
                onValueChange={(enabled) => setEditing({ ...editing, form: { ...editing.form, enabled } })}
              />
              <Text>Enabled</Text>
            </View>
            {formError ? <Text style={appStyles.textDanger}>{formError}</Text> : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <AppActionButton title="Save routine" onPress={saveForm} />
              <AppActionButton
                title="Cancel"
                onPress={async () => {
                  setEditing(null)
                  setFormError(null)
                }}
              />
            </View>
          </View>
        </View>
      ) : (
        <AppActionButton
          title="New routine"
          onPress={async () => setEditing({ id: null, form: emptyForm(bots[0]?.id ?? '') })}
        />
      )}

      {recentRuns.length > 0 ? (
        <>
          <Text style={{ fontWeight: 'bold' }}>Recent runs</Text>
          {recentRuns.map((run) => (
            <View key={run.id} style={appStyles.card}>
              <Text style={{ fontWeight: 'bold' }}>
                {run.routineName} · {run.status}
                {run.manual ? ' · manual' : ''}
              </Text>
              <Text>{new Date(run.scheduledFor).toLocaleString()}</Text>
              {run.error ? (
                <Text style={appStyles.textDanger}>{run.error}</Text>
              ) : run.output ? (
                <Text numberOfLines={2}>{run.output}</Text>
              ) : null}
            </View>
          ))}
        </>
      ) : null}
    </ScrollView>
  )
}

const localStyles = StyleSheet.create({
  chip: {
    borderColor: '#d1d1d1',
    borderRadius: 2,
    borderWidth: 1,
    padding: 6,
  },
  chipOff: {
    opacity: 0.45,
  },
  chipOn: {
    backgroundColor: '#9945FF26',
    borderColor: '#9945FF',
    borderRadius: 2,
    borderWidth: 1,
    padding: 6,
  },
  input: {
    borderColor: '#d1d1d1',
    borderRadius: 2,
    borderWidth: 1,
    padding: 8,
  },
})
