# ClawdMobile (Android / Solana Mobile)

ClawdMobile is the phone companion for Clawd Bot on your computer. Pair once by scanning the QR code Clawd Bot shows, then follow your bots, answer approval requests, and connect a Solana wallet through Mobile Wallet Adapter / Seeker Connect.

- Android package: `com.clawdbot.app`
- Default network: Solana devnet (mainnet is not enabled in this build)
- Support: clawdbot@mail.grokbot.com

## Develop

```bash
npm ci
npm run dev          # Metro for the dev client
npm run android      # build + install the dev client on a device/emulator
```

## Checks

```bash
npx tsc --noEmit
npm test             # vitest
npm run lint:check
```

## Release builds

Release builds are signed with a dedicated release key supplied at build time; they never use the debug key. See [`docs/release/RELEASE.md`](docs/release/RELEASE.md). Keys, keystores, `credentials.json` and `.env` files must never be committed.

Store submission material lives in [`docs/release/`](docs/release/).

## Project notes

Architecture and history: [`SCAFFOLD.md`](SCAFFOLD.md). The `reset-project` script inherited from the Seeker Connect template is still present but is not part of the ClawdMobile workflow.
