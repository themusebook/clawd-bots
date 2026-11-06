import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Linking from 'expo-linking'
import { Link } from 'expo-router'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import { PairingFlow, type PairingPhase } from '@/companion-core/pairing-flow'
import { connectionDisplayAddress } from '@/companion-core/connection'
import { appStyles } from '@/constants/app-styles'
import { useCompanion } from '@/features/companion/companion-provider'
import { SecureSessionStore } from '@/features/pairing/secure-session-store'

const localStyles = StyleSheet.create({
  camera: {
    borderRadius: 2,
    height: 300,
  },
  input: {
    backgroundColor: '#ffffff',
    borderColor: '#d1d1d1',
    borderRadius: 2,
    borderWidth: 1,
    padding: 8,
  },
  mono: {
    fontFamily: 'monospace',
  },
})

/**
 * Pairing screen — renders the headless PairingFlow (companion-core). Entry
 * points mirror iOS PairingView:
 *  - scan the QR from Clawd Bot → Settings → Companion (expo-camera),
 *  - paste a pairing link, or open one via the clawdbot:// scheme,
 *  - type the address (LAN, or a Tailscale MagicDNS name — never the
 *    100.64/10 address) plus the code shown on the computer.
 * Nearby discovery (Bonjour `_clawdbot._tcp` / Android NSD) is the one entry
 * point not wired yet: it needs the NSD native module, which lands with the
 * first on-device build rather than as unverifiable native code.
 * The token lands in Keystore-backed storage (SecureSessionStore); a
 * relaunch returns to "paired" with no new code.
 */
export function PairingFeature() {
  const flowRef = useRef<PairingFlow | null>(null)
  if (!flowRef.current) {
    flowRef.current = new PairingFlow({ store: new SecureSessionStore(), deviceName: 'ClawdMobile (Android)' })
  }
  const flow = flowRef.current
  const { reload: reloadCompanion } = useCompanion()
  const [, setTick] = useState(0)
  const refresh = useCallback(() => setTick((tick) => tick + 1), [])
  const phase = flow.phase

  const [scanning, setScanning] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  const scannedRef = useRef(false)
  const [linkText, setLinkText] = useState('')
  const [address, setAddress] = useState('')
  const [credential, setCredential] = useState('')

  useEffect(() => {
    void flow.restore().then(refresh)
  }, [flow, refresh])

  useEffect(() => {
    function accept(url: string) {
      if (url.startsWith('clawdbot://')) {
        flow.acceptInviteLink(url)
        refresh()
      }
    }
    void Linking.getInitialURL().then((url) => {
      if (url) accept(url)
    })
    const subscription = Linking.addEventListener('url', ({ url }) => accept(url))
    return () => subscription.remove()
  }, [flow, refresh])

  function onScanned(data: string) {
    if (scannedRef.current) return
    scannedRef.current = true
    setScanning(false)
    flow.acceptInviteLink(data)
    refresh()
  }

  async function startScanning() {
    scannedRef.current = false
    if (!permission?.granted) {
      const result = await requestPermission()
      if (!result.granted) return
    }
    setScanning(true)
  }

  return (
    <ScrollView>
      <View style={appStyles.stack}>
        {phase.kind === 'paired' ? (
          <PairedCard
            phase={phase}
            onUnpair={() => {
              void flow.unpair().then(() => {
                refresh()
                reloadCompanion()
              })
            }}
          />
        ) : phase.kind === 'review' || phase.kind === 'pairing' ? (
          <View style={appStyles.card}>
            <View style={appStyles.stack}>
              <Text style={appStyles.title}>Pair with {phase.invite.connection.name}?</Text>
              <Text>
                You&apos;re about to connect to <Text style={localStyles.mono}>{phase.consentOrigin}</Text>
              </Text>
              <Text>{phase.transportNote}</Text>
              <Text>
                Only pair with a computer you own. The pairing code is single-use; the device token it creates stays on
                this phone and can be revoked from the computer.
              </Text>
              <Button
                title={phase.kind === 'pairing' ? 'Pairing…' : 'Pair this phone'}
                disabled={phase.kind === 'pairing'}
                onPress={() => {
                  void flow.confirmPair().then(() => {
                    refresh()
                    // The companion session was built from whatever was
                    // stored at launch — rebuild it on the new pairing.
                    if (flow.phase.kind === 'paired') reloadCompanion()
                  })
                }}
              />
              <Button
                title="Cancel"
                disabled={phase.kind === 'pairing'}
                onPress={() => {
                  flow.cancelReview()
                  refresh()
                }}
              />
            </View>
          </View>
        ) : phase.kind === 'failed' ? (
          <View style={appStyles.card}>
            <View style={appStyles.stack}>
              <Text style={appStyles.title}>Pairing didn&apos;t finish</Text>
              <Text style={appStyles.textDanger}>{phase.message}</Text>
              {phase.canRetry ? (
                <Button
                  title="Retry"
                  onPress={() => {
                    void flow.confirmPair().then(refresh)
                  }}
                />
              ) : null}
              <Button
                title="Start over"
                onPress={() => {
                  flow.cancelReview()
                  refresh()
                }}
              />
            </View>
          </View>
        ) : (
          <View style={appStyles.stack}>
            <View style={appStyles.card}>
              <View style={appStyles.stack}>
                <Text style={appStyles.title}>Scan the QR code</Text>
                <Text>On your computer: Clawd Bot → Settings → Companion → show the pairing QR.</Text>
                {scanning ? (
                  <CameraView
                    style={localStyles.camera}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={({ data }) => onScanned(data)}
                  />
                ) : (
                  <Button title="Scan QR code" onPress={() => void startScanning()} />
                )}
                {scanning ? (
                  <Button
                    title="Stop scanning"
                    onPress={() => {
                      setScanning(false)
                    }}
                  />
                ) : null}
              </View>
            </View>

            <View style={appStyles.card}>
              <View style={appStyles.stack}>
                <Text style={appStyles.title}>Paste a pairing link</Text>
                <TextInput
                  style={localStyles.input}
                  value={linkText}
                  onChangeText={setLinkText}
                  placeholder="clawdbot://pair?address=…"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Button
                  title="Use this link"
                  disabled={linkText.trim().length === 0}
                  onPress={() => {
                    flow.acceptInviteLink(linkText)
                    refresh()
                  }}
                />
              </View>
            </View>

            <View style={appStyles.card}>
              <View style={appStyles.stack}>
                <Text style={appStyles.title}>Type it instead</Text>
                <Text>
                  The computer&apos;s address — a name like ada.ts.net, or a LAN address — and the code it shows. Use
                  the Tailscale name, never the 100.64… address.
                </Text>
                <TextInput
                  style={localStyles.input}
                  value={address}
                  onChangeText={setAddress}
                  placeholder="ada.ts.net or 192.168.1.20"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TextInput
                  style={localStyles.input}
                  value={credential}
                  onChangeText={setCredential}
                  placeholder="Six-digit code or pairing token"
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                />
                <Button
                  title="Review this computer"
                  disabled={address.trim().length === 0 || credential.trim().length === 0}
                  onPress={() => {
                    flow.acceptManual(address, credential)
                    refresh()
                  }}
                />
              </View>
            </View>

            <View style={appStyles.card}>
              <Text>
                Nearby discovery (your computer appearing on its own, like on iPhone) arrives with the first on-device
                build — it needs Android&apos;s NSD service, which can only be verified on hardware.
              </Text>
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  )
}

function PairedCard({ phase, onUnpair }: { phase: Extract<PairingPhase, { kind: 'paired' }>; onUnpair: () => void }) {
  const { session } = phase
  return (
    <View style={appStyles.card}>
      <View style={appStyles.stack}>
        <Text style={appStyles.title}>Paired with {session.connection.name}</Text>
        <Text>
          Reachable at <Text style={localStyles.mono}>{connectionDisplayAddress(session.connection)}</Text>. The device
          token is in this phone&apos;s secure storage — relaunching the app keeps you paired.
        </Text>
        <Link href="/roster">Open the roster →</Link>
        <Button title="Unpair this phone" onPress={onUnpair} />
        <Text>Unpairing here only forgets the token on this phone. Revoke the device from the computer too.</Text>
      </View>
    </View>
  )
}
