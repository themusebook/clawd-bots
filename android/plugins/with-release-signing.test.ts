import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { applyReleaseSigning, SIGNING_KEYS } = require('./with-release-signing.js')

const TEMPLATE = `apply plugin: "com.android.application"

android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`

describe('applyReleaseSigning', () => {
  const out = applyReleaseSigning(TEMPLATE)
  const release = out.slice(out.indexOf('buildTypes'))

  it('points the release build type at a dedicated release signing config', () => {
    expect(release).toMatch(/release\s*\{[^}]*signingConfig signingConfigs\.release/)
    expect(release.match(/signingConfigs\.debug/g)).toHaveLength(1)
  })

  it('keeps debug builds on the debug key', () => {
    expect(release).toMatch(/debug\s*\{\s*signingConfig signingConfigs\.debug/)
  })

  it('reads every credential from properties/env and fails release tasks when missing', () => {
    for (const key of SIGNING_KEYS) expect(out).toContain(key)
    expect(out).toContain('throw new GradleException')
    expect(out).not.toMatch(/storePassword '(?!android')/)
  })

  it('is idempotent', () => {
    expect(applyReleaseSigning(out)).toBe(out)
  })

  it('refuses an unexpected layout rather than shipping debug signing', () => {
    expect(() => applyReleaseSigning('android {}')).toThrow()
  })
})
