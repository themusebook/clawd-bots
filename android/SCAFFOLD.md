# ClawdMobile for Android / Solana Mobile — scaffold notes

Scaffolded 2026-10-31 on the Muse VM at `~/workspace/clawdmobile-android/clawdmobile/`.
Goal: `goal_5ecdddb1e163` (Solana Mobile app from the iOS Clawd Bots app).
Inventory it is built against: the goal's `files/iOS-Inventory-and-Android-Parity.md`.

## How it was made

```bash
npx solana-mobile@latest create clawdmobile --template expo-kit-minimal --skip-install --skip-git
```

The `expo-kit-minimal` template is the one the Solana Mobile docs point at for
Seeker Connect: Expo SDK 58 / React Native 0.88, `@solana/kit`,
`@wallet-ui/react-native-kit`, `@solana-mobile/seeker-connect-react-native`
0.2.0, crypto polyfill-first entry (`polyfill.js` → `index.js`), Vitest +
React Native Testing Library, and an L3 fakewallet e2e script.

## What was changed from the template

- `app.json` — name **ClawdMobile**, slug `clawdmobile`, scheme **`clawdbot`**
  (the iOS pairing deep-link scheme), Android package **`com.clawdbot.app`**
  (same bundle id as iOS), version 1.0.0.
- `package.json` — displayName / description set to ClawdMobile.
- `constants/app-config.ts` — wallet identity is now
  `{ name: 'ClawdMobile', uri: 'https://clawdbot.party', icon: 'favicon.ico' }`
  (https is mandatory; icon resolves relative to the uri). Clusters stay
  devnet / localnet / testnet — mainnet needs an explicit RPC URL, added only
  with the owner's own endpoint.
- `components/seeker-wallet-provider.tsx` — **unchanged, and already correct**:
  it calls `SeekerConnect.configure()` and `SeekerConnect.restore()` on load,
  and exposes connect / disconnect / signIn / signMessages / sendTransactions
  built on `@solana/kit`. The template's account + network demo features stay
  as the working wallet proof on the home screen.
- `app/index.tsx` — ClawdMobile home: companion intro + pairing/roster entry
  points above the wallet sections.
- `app/pairing.tsx`, `app/roster.tsx` — placeholder screens whose source
  comments carry the exact Tier-1 spec from the iOS PairingView / ChatListView.
- `companion-core/` — the TypeScript port of iOS CompanionCore, started:
  - `models.ts` — wire types from Models.swift, shaped by the fixtures;
    includes the BotActivity contract from `Shared/BotActivity.swift`.
  - `sse.ts` — raw SSE parser (blank-line event boundaries, no line folding)
    + frame decoding that absorbs unknown kinds.
  - `store.ts` — the fold: hydrate + hello/message/bot frames, resume cursor,
    Updates-pill rule. message.patch / runtime deltas are the next port.
  - `client.ts` — CompanionClient with the roster read wired and the rest of
    the allowed surface as typed stubs that name their iOS source. The
    refused surface is documented and deliberately absent.
  - `fixtures/` — the iOS CompanionCoreTests fixtures, copied from the Mac
    (bots-full, bots-paged, thread-page, sse-frames, sse-hello, options-card,
    pair-response, config, instances, bot-avatar-profile, unauthorized,
    forbidden, pair-rejected). Never hand-edit: a fixture diff is a contract
    change.
  - `sse.test.ts` / `store.test.ts` — the port's first contract tests,
    including a full replay of the captured stream fixture.

## Verify

```bash
npm install
npx tsc --noEmit
npm test
npm run android   # needs an Android device/emulator + a dev build; Expo Go will not work
```

**Verified on the VM 2026-10-31:** `npm install` clean, `tsc --noEmit` clean,
`npm run format:check` clean, `npm run lint:check` clean, **`npm test` 151/151
passed (16 files)** — including the companion-core contract tests and the
template's own reset-project suite. Fixtures in `companion-core/fixtures/`
are byte-identical copies of the Mac originals (sizes match the iOS listing
exactly) and are prettier-ignored on purpose.
**Not verified here:** the Android build itself — this VM has no Android SDK,
so `npm run android` / prebuild runs first on the Mac (Android Studio) or a
device. Two scaffold bugs were caught and fixed by the tests on the way in:
the fold now advances the resume cursor on every sequenced frame (not just
messages), and captured fixtures are excluded from prettier.

## Pairing client — ported 2026-10-31

`companion-core/endpoint.ts` + `connection.ts` + `pairing.ts` are a faithful
port of iOS `Endpoint.swift`, the `Connection` route policy in
`Failover.swift`, and the pairing flow in `Client.swift`:

- `parsePairingInvite` — `clawdbot://pair?…`: `omb_pair_` token (exactly 52
  chars) or legacy 6-digit code, duplicate query keys reject, base64url
  `endpoints` (present-but-invalid rejects the invite — no silent downgrade
  from hosted HTTPS to legacy HTTP), advisory `hosts` filtered, display name
  cleaned and capped at 80.
- Route policy — kinds hosted/tailnet are credential-protected; lan/bonjour
  are cleartext and need the exact consented origin. An invite binds policy
  to the selected route; a pair response can never widen it.
- `pairFirstReachable` — health-probes the automatic routes (a route counts
  only if `/api/health` answers and identifies as `app: "clawdbot"`),
  redeems on the first healthy route in priority order (speed never outranks
  policy), never probes/redeems cleartext speculatively, never re-sprays a
  rejection at another address, retries transport/gateway failures with the
  SAME `pairRequestId`, and throws `PairingRouteError` with the credential
  unspent when nothing answers. The winner connection is what gets persisted.
- `client.ts` now sits on `Connection` and also ports `getThreadPage` and
  `connectionMetadata`; the remaining allowed methods stay typed stubs.

21 pairing tests in `companion-core/pairing.test.ts` mirror
`PairingTests.swift` scenario-for-scenario. The iOS reference sources used
for the port are kept in `../ios-reference/` (outside the app).

## Pairing UI — built 2026-10-31

- `companion-core/pairing-flow.ts` — the headless state machine the screen
  renders (methods → review → pairing → paired/failed), with the consent
  origin and an honest per-route transport note computed in core, one
  pairRequestId per review (retries reuse it), and restore()/unpair().
  `companion-core/session.ts` is the storage contract; 10 flow/session tests.
- `features/pairing/pairing-feature.tsx` — scan the QR (expo-camera, added
  ~58.0.14 with a scan-only camera permission string), paste or open a
  clawdbot://pair link (expo-linking listener), or type address + code.
  Confirm-before-connect, Retry on route failures, Start over on rejections.
- `features/pairing/secure-session-store.ts` — the session (device token
  included) persists via expo-secure-store (~58.0.2, Keystore-backed on
  Android). Home screen now reflects the real paired state.
- Nearby discovery (Bonjour `_clawdbot._tcp` / Android NSD) is the one entry
  point NOT wired: it needs the NSD native module, which lands with the
  first on-device build instead of as unverifiable native code.
- The template's reset-project tool now replaces the pairing/roster screens
  with placeholders on reset (its suite caught them pointing at deleted
  feature code; companion-core survives a reset by design).

## Roster + chat — built 2026-10-31

- Client verbs ported to the exact Client.swift routes (the stubs' guesses
  were wrong in instructive ways): send = POST /api/bots/{id}/messages or
  /api/groups/{id}/messages; respond = POST /api/threads/{id}/respond
  {requestId, behavior, message?}; read = POST …/read keyed by bot/room;
  interrupt = POST /api/bots/{id}/interrupt; plus always-allow, createBot,
  createRoom. The stream is GET /api/events?screens=off&since=<cursor>
  (NOT /api/stream), and it must not inherit the 20s API timeout (25s
  keepalive) — documented on eventsUrl.
- `companion-core/cards.ts` — OptionCard rules: pending = requestId +
  unanswered + not dismissed; permission = has tool; behavior mapping
  (refusal → deny, any other permission choice → allow, question → answer
  with the choice as message).
- `companion-core/live-session.ts` — hydrate → stream → fold with backoff
  reconnect (1s→30s), resume from the fold cursor, re-hydrate on
  resumed:false, 401 → revoked (no retry loop), roster/chat selectors and
  actions. 9 live-session tests use a scripted transport + the real bots
  fixture. (Test-design note: a microtask sleep + instantly-failing
  transport starves timers — the loop's sleep must be a real timer.)
- App side: CompanionProvider (one session for the app, reloads after
  pairing), FetchStreamTransport (fetch reader; fails loudly when a build
  has no readable body — on-device verification pending), RosterFeature
  (Updates pill, revoked state, New bot), ChatFeature at /thread/[id]
  (transcript, pending cards answered in place, composer, interrupt,
  scrollback, mark-read on open). Mascot faces wait on the ClawdAvatar
  palette port.

## BotActivity notifications — built 2026-10-31

- `companion-core/activity.ts` — deriveActivities (one per bot: pending card
  → needsYou, else `busy` flag → working, else unread → toReview; hidden
  bots and bots with notifications off never appear; rooms never appear —
  the iOS contract is keyed by bot) + planNotificationSync (pure diff:
  present new/changed, dismiss vanished). 6 tests.
- Also fixed from the Swift sources while here: Session.answer remembers
  "Always allow" BEFORE responding, with the card's own key —
  LiveSession.answerCard now does the same, and answerByRequest(threadId,
  requestId, choice) serves callers that only have ids. And createBot folds
  the new bot into state immediately, like iOS (creation does not broadcast).
- App side (expo-notifications ~58.1.7): one ongoing (sticky) notification
  per active bot on a high-importance channel; needs-you cards register a
  per-request category whose action buttons ARE the card's options; body
  tap opens the thread; action taps route to answerByRequest via the
  CompanionProvider (queued and retried on the next fold change when the
  answer lands before hydration — the cold-start case). Revoked/unpaired
  clears all. (Corrected against LiveActivities.swift in the mascot pass:
  the sync carries needsYou + working only — toReview stays with the pill,
  as on iOS — and the activity face is now the real forBot state.)
- On-device verification (real notification posting, action delivery) is
  part of the first Mac build, like the stream transport and NSD.

## Mascot faces — built 2026-10-31

- `scripts/generate-mascot-data.py` generates `companion-core/mascot-data.ts`
  (49KB, prettier-ignored like the fixtures) from the iOS sources: the
  silhouette path baked into face-box coordinates with the desktop's exact
  transforms, expressionsFlat (25×2×48 points), gaze, mouths, and the
  per-state pools for all 40 ClawdStates. Re-run it if the Swift tables move.
- `companion-core/mascot.ts` — the palette (CLAWD_COLORS + grey fallback,
  gradient stops via sRGB mix), normalizeClawdState (legacy aliases),
  clawdStateForBot (MascotState.swift's exact order: pinned → failed tool →
  busy → unread → waiting-on-answer → role word tables → idle; rooms wear
  "happy" in blue), and faceGeometry — the still face exactly as
  ClawdFaceStill draws it (resting = pool's first expression, gaze × 0.35,
  mouth hung off the eye rings). 10 tests.
- Renderer: features/companion/clawd-avatar-face.tsx (react-native-svg
  15.16) — gradient body, face clipped to the silhouette. Wired into roster
  rows (RosterEntry now carries color + face) and the chat header.
- NOT ported: the animation engine (spring morphs, blink, comets, body
  bob) — iOS itself makes animation opt-in per surface; stills are the
  list/profile face. Bot avatar IMAGES (avatarUrl + crop, fetched with the
  device bearer) also remain: the mascot is the deterministic fallback
  iOS uses for those too.

## Remaining client methods — built 2026-10-31

The client now covers ALL of Client.swift's allowed surface (13 new tests
in client-methods.test.ts): search (hits unwrap; land via
getThreadPage around:), export (bytes + Content-Disposition filename,
parsed like Swift), instances, config, connector catalog + statuses,
message images, avatar fetch (path validated like shared/bot-avatar.ts
before any request), voices + preview (500-char cap), routines (list,
create/update with the unknown-schedule guard and Swift's body shape,
enable patch, run, delete), updateProfile (set/clear avatar encoding),
uploadAvatar (mime + 10 MB guards, canonical path rebuild), generateAvatar
(400-char prompt cap, 150s timeout for the server's 120s provider budget),
authorizeConnector (slug guard, trimmed alias, https-only result),
toggleReaction, editMessage, setActiveBranch, tasks (create/switch/
rename/delete), cloudDesktop (joinUrl unwrap, https-only; the URL is a
bearer credential — present, never store). The request core grew a raw
mode (bytes in/out) for export/images/voice/upload. NotPortedError is gone
— there is nothing left unported in the client.

Avatar IMAGES are wired: features/companion/bot-avatar.tsx follows
BotAvatarView's rule (custom image when avatarUrl + crop != mascot,
fetched with the device bearer via LiveSession.avatarImage, cached per
path; mascot on absence or failure) in roster rows and the chat header.

## Search screen — built 2026-10-31

- Core: LiveSession.search() passthrough + loadAround(threadId, messageId)
  — fetches the around-page only when the hit is not already held, merges
  deduped by id in time order, and only moves the scrollback boundary when
  the page reached older ground. 4 tests.
- UI: features/search/search-feature.tsx at app/search.tsx (roster gains a
  "Search messages" button): debounced (300ms, stale responses dropped by
  sequence), hits show bot/room + task, the snippet with the match bolded
  from matchStart/matchLength, and the time. Tap → /thread/[id] with a
  highlight param.
- Landing: the chat screen suppresses its scroll-to-end while a landing is
  pending, fetches around the hit when missing, then scrolls to the row
  once it lays out and flashes it (Solana-purple tint) for ~2.6s, once.
- The reset script placeholders app/search.tsx like the other companion
  screens (its JSX text is prettier-wrapped — the reset suite checks).

## Routines screen — built 2026-10-31

- Core: companion-core/routines.ts — canToggleRoutine (the desktop policy:
  daily always, once only while its instant is ahead, unknown never),
  scheduleSummary, runAvailability (Box configured + an available boxAgent
  instance; snapshot availability is state == "available", a computed on
  iOS, not a wire field) + canSelectLocation (cloud selectable when ready
  or when it is the routine's current home). 4 tests. LiveSession gained
  routines/config/instances passthroughs.
- UI: features/routines/routines-feature.tsx at app/routines.tsx (roster
  button): list with per-routine Run now / Edit / two-tap Delete and the
  policy-gated enable switch, recent runs, and a create/edit form — bot
  chips, run-location chips (cloud shows "not ready" and is disabled when
  unavailable), daily (time + weekday chips) or once (date + time),
  duration, enabled. Everything refetches after a mutation; no optimistic
  state. Weekday numbers use the harness's JS convention (0 = Sunday);
  that mapping is the one convention not verifiable from the iOS sources
  alone (they pass the ints through opaquely).
- The reset script placeholders app/routines.tsx like the other screens.

## Connectors screen — built 2026-10-31

- Core: companion-core/connectors.ts — connectorAccountIsActive (the exact
  normalized comparison from Models.swift: trimmed, uppercased, == ACTIVE;
  INACTIVE must never render as connected) and connectorRows (statuses are
  the inventory — "a catalog page is not an account list" — the catalog
  only labels and extends; ordered connected → pending → available).
  3 tests. LiveSession gained catalog/statuses/authorize passthroughs.
- UI: features/connectors/connectors-feature.tsx at app/connectors.tsx
  (roster button "Connected apps"): rows with accounts and their real
  statuses, pending state, and the authorize flow (optional account
  label → the client's https-checked URL → browser). The screen refetches
  on focus, so returning from the browser shows the new state. No
  disconnect button — revocation stays on the computer, and the screen
  says so. Not-configured (Composio unset) is an explained empty state.
- The reset script placeholders app/connectors.tsx like the other screens.

## Not done yet (next, in order)

1. UI for the rest of the ported methods: bot profile editing, message
   reactions/edit UI, and the dictation + cloud-desktop viewers.
2. ~~Pairing UI and Keystore-backed token storage~~ — done above; the NSD
   discovery entry point remains, with the first on-device build.
3. ~~Roster + chat on the fold, approval cards~~ — done above. Remaining in
   this tier: dictation, computer view, search.
4. ~~BotActivity → ongoing Android notifications with inline approval answers~~
   — done above.
5. ~~Copy this project into the clawd-bots repo as `android/` beside `ios/`~~
   — done on branch `solana-mobile-release-prep` (2026-11-05).
6. dApp Store: release prep landed 2026-11-05 — `plugins/with-release-signing.js`
   (release builds require `CLAWD_RELEASE_*` credentials and never fall back
   to the debug key), `eas.json` `dapp-store` APK profile, `versionCode` 1,
   explicit Android permissions, and `docs/release/` (listing, reviewer notes,
   release steps, asset checklist). Still open: Digital Asset Links for
   `com.clawdbot.app` against the release key fingerprint (the website's
   current assetlinks names a different package), real screenshots, legal
   URLs, publisher details, signed arm64 APK and on-device QA.
7. Seeker install: build the dev client on the Mac (Android Studio) and
   install on the owner's Seeker — it pairs as `com.clawdbot.app` and the
   wallet flows run through Seeker Connect / MWA on-device. Owner asked for
   this 2026-10-31; the Seeker was offline in Muse (last seen 2026-10-20)
   and the VM has no Android SDK, so this is a Mac step.
