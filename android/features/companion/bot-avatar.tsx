import React, { useEffect, useState } from 'react'
import { Image } from 'react-native'

import type { ClawdState } from '@/companion-core/mascot'
import { useCompanion } from '@/features/companion/companion-provider'
import { ClawdAvatarFace } from '@/features/companion/clawd-avatar-face'

/**
 * A bot's avatar — port of iOS App/BotAvatarView.swift's rule: a custom
 * image wins when the bot has one AND its crop is not "mascot"; otherwise
 * (and on any fetch failure) the mascot is the face. Custom avatars are
 * app-owned attachments fetched with the device bearer — never a plain
 * image URL — so they arrive as bytes and render from a data URI, cached
 * per path for the app's lifetime.
 */

const cache = new Map<string, string>()

function bytesToDataUri(bytes: Uint8Array, path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png'
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

function cropRadius(crop: string | undefined, size: number): number {
  if (crop === 'circle') return size / 2
  if (crop === 'rounded') return size * 0.22
  return 0
}

export function BotAvatar({
  avatarUrl,
  avatarCrop,
  color,
  state,
  size = 44,
}: {
  avatarUrl?: string
  avatarCrop?: string
  color: string
  state: ClawdState
  size?: number
}) {
  const { session } = useCompanion()
  const wantsImage = Boolean(avatarUrl) && avatarCrop !== undefined && avatarCrop !== 'mascot'
  const [uri, setUri] = useState<string | null>(() => (avatarUrl ? (cache.get(avatarUrl) ?? null) : null))

  useEffect(() => {
    if (!wantsImage || !avatarUrl || !session) return
    const cached = cache.get(avatarUrl)
    if (cached) {
      setUri(cached)
      return
    }
    let cancelled = false
    session
      .avatarImage(avatarUrl)
      .then((bytes) => {
        const dataUri = bytesToDataUri(bytes, avatarUrl)
        cache.set(avatarUrl, dataUri)
        if (!cancelled) setUri(dataUri)
      })
      .catch(() => {
        // The mascot is the fallback — iOS falls back the same way.
      })
    return () => {
      cancelled = true
    }
  }, [wantsImage, avatarUrl, session])

  if (wantsImage && uri) {
    return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: cropRadius(avatarCrop, size) }} />
  }
  return <ClawdAvatarFace color={color} state={state} size={size} />
}
