# Release process (Solana dApp Store)

Nothing here has been run yet. Signing and submission are done by the owner.

## Signing

`plugins/with-release-signing.js` rewrites the generated `android/app/build.gradle` during `expo prebuild`:

- adds a `release` signing config fed by `CLAWD_RELEASE_STORE_FILE`, `CLAWD_RELEASE_STORE_PASSWORD`, `CLAWD_RELEASE_KEY_ALIAS`, `CLAWD_RELEASE_KEY_PASSWORD` (Gradle properties or environment variables);
- points the `release` build type at it;
- fails any release task if a value is missing — there is no debug fallback.

On EAS Build (`EAS_BUILD=true`) EAS injects its managed release keystore instead.

Use a **dedicated** key for the dApp Store (not the Google Play upload key). Keep it outside the repo and back it up; losing it means you cannot update the app.

## Build (owner step)

Local:

```bash
npx expo prebuild -p android --clean
export CLAWD_RELEASE_STORE_FILE=/abs/path/outside/repo/clawd-dappstore.keystore  # plus the other three
cd android && ./gradlew :app:assembleRelease
```

EAS: `eas build -p android --profile dapp-store`

Requirements: release-signed APK (not AAB), includes arm64-v8a, ≤ 2 GB, `versionCode` incremented for every submission (`app.json` → `expo.android.versionCode`).

Verify: `apksigner verify --print-certs app-release.apk` shows the release cert, not "Android Debug".

## Digital Asset Links

Publish `/.well-known/assetlinks.json` on the app's website for package `com.clawdbot.app` with the release key's SHA-256 fingerprint. **Blocker:** the live file currently names a different package. Website changes are out of scope for this PR.

## Submit (owner step)

Through the Solana dApp Store publisher portal, using `STORE_LISTING.md`, `REVIEWER_NOTES.md` and the assets in `ASSET_CHECKLIST.md`.
