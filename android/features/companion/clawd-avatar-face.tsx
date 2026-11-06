import React, { useId } from 'react'
import Svg, { ClipPath, Defs, G, LinearGradient, Path, Polygon, Stop } from 'react-native-svg'

import {
  FACE_TRANSFORM,
  FACE_VIEWBOX,
  MOUTH_STROKE,
  faceGeometry,
  gradientStops,
  type ClawdState,
} from '@/companion-core/mascot'
import { SILHOUETTE_BOUNDS, SILHOUETTE_FACEBOX_PATH } from '@/companion-core/mascot-data'

/**
 * The bot's face — the desktop silhouette with the resting expression for
 * its state, drawn exactly as iOS ClawdFaceStill draws it: gradient body in
 * the bot's palette colour, face clipped to the body, white eye rings and
 * mouth from the generated Blob Studio tables (companion-core/mascot.ts).
 *
 * Stills only, deliberately: on iOS, animation is opt-in per surface because
 * a mounted face costs a 30fps canvas. The animated engine is a later layer
 * for the places motion carries meaning (a busy bot, the needs-you moment).
 */
export function ClawdAvatarFace({ color, state, size = 52 }: { color: string; state: ClawdState; size?: number }) {
  const geometry = faceGeometry(state)
  const [light, base, dark] = gradientStops(color)
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const gradientId = `clawd-body-${uid}`
  const clipId = `clawd-clip-${uid}`
  const bounds = SILHOUETTE_BOUNDS

  return (
    <Svg width={size} height={size} viewBox={FACE_VIEWBOX} accessibilityElementsHidden>
      <Defs>
        <LinearGradient
          id={gradientId}
          x1={bounds.maxX}
          y1={bounds.minY}
          x2={bounds.minX}
          y2={bounds.maxY}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0" stopColor={light} />
          <Stop offset="0.55" stopColor={base} />
          <Stop offset="1" stopColor={dark} />
        </LinearGradient>
        <ClipPath id={clipId}>
          <Path d={SILHOUETTE_FACEBOX_PATH} />
        </ClipPath>
      </Defs>
      <Path d={SILHOUETTE_FACEBOX_PATH} fill={`url(#${gradientId})`} />
      <G clipPath={`url(#${clipId})`}>
        <G transform={FACE_TRANSFORM}>
          <Polygon points={geometry.ringPolygons[0]} fill="#FFFFFF" />
          <Polygon points={geometry.ringPolygons[1]} fill="#FFFFFF" />
          <Path d={geometry.mouthD} stroke="#FFFFFF" strokeWidth={MOUTH_STROKE} strokeLinecap="round" fill="none" />
        </G>
      </G>
    </Svg>
  )
}
