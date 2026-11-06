/**
 * Expo config plugin: release builds sign with a dedicated upload/release key, never the debug key.
 *
 * Credentials come from Gradle properties or environment variables at build time:
 *   CLAWD_RELEASE_STORE_FILE, CLAWD_RELEASE_STORE_PASSWORD, CLAWD_RELEASE_KEY_ALIAS, CLAWD_RELEASE_KEY_PASSWORD
 * Nothing secret lives in this repo. If any value is missing, any release task fails instead of
 * silently falling back to debug signing. EAS Build (EAS_BUILD=true) injects its own managed
 * release signing, so the guard defers to it there.
 */
const { withAppBuildGradle } = require('@expo/config-plugins')

const MARKER = '// clawd-release-signing'
const KEYS = [
  'CLAWD_RELEASE_STORE_FILE',
  'CLAWD_RELEASE_STORE_PASSWORD',
  'CLAWD_RELEASE_KEY_ALIAS',
  'CLAWD_RELEASE_KEY_PASSWORD',
]

const HELPER = `${MARKER}
def clawdSigningValue = { String name -> project.findProperty(name) ?: System.getenv(name) }
def clawdReleaseSigningReady = [${KEYS.map((k) => `'${k}'`).join(', ')}].every { clawdSigningValue(it) }
gradle.taskGraph.whenReady { graph ->
    def releaseTask = graph.allTasks.any { it.project == project && it.name.toLowerCase().contains('release') }
    if (releaseTask && !clawdReleaseSigningReady && System.getenv('EAS_BUILD') != 'true') {
        throw new GradleException('Release signing is not configured. Set ${KEYS.join(', ')} (Gradle properties or env). Debug signing is never used for release.')
    }
}
`

const RELEASE_SIGNING_CONFIG = `
        release {
            if (clawdReleaseSigningReady) {
                storeFile file(clawdSigningValue('CLAWD_RELEASE_STORE_FILE'))
                storePassword clawdSigningValue('CLAWD_RELEASE_STORE_PASSWORD')
                keyAlias clawdSigningValue('CLAWD_RELEASE_KEY_ALIAS')
                keyPassword clawdSigningValue('CLAWD_RELEASE_KEY_PASSWORD')
            }
        }`

function applyReleaseSigning(gradle) {
  if (gradle.includes(MARKER)) return gradle

  const androidIdx = gradle.search(/^android\s*\{/m)
  const signingIdx = gradle.search(/signingConfigs\s*\{/)
  const buildTypesIdx = gradle.search(/buildTypes\s*\{/)
  if (androidIdx < 0 || signingIdx < 0 || buildTypesIdx < 0) {
    throw new Error('with-release-signing: unexpected android/app/build.gradle layout')
  }

  const releaseRe = /(release\s*\{[^}]*?)signingConfig\s+signingConfigs\.debug/
  const tail = gradle.slice(buildTypesIdx)
  if (!releaseRe.test(tail)) {
    throw new Error('with-release-signing: release buildType does not reference signingConfigs.debug')
  }
  let out = gradle.slice(0, buildTypesIdx) + tail.replace(releaseRe, '$1signingConfig signingConfigs.release')

  const open = out.match(/signingConfigs\s*\{/)
  const at = open.index + open[0].length
  out = out.slice(0, at) + RELEASE_SIGNING_CONFIG + out.slice(at)

  return out.slice(0, androidIdx) + HELPER + out.slice(androidIdx)
}

const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('with-release-signing: only Groovy build.gradle is supported')
    }
    cfg.modResults.contents = applyReleaseSigning(cfg.modResults.contents)
    return cfg
  })

module.exports = withReleaseSigning
module.exports.applyReleaseSigning = applyReleaseSigning
module.exports.SIGNING_KEYS = KEYS
