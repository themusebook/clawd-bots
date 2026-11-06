# Notes for dApp Store reviewers

- **Purpose:** companion app for Clawd Bot on the user's computer.
- **Pairing:** the app needs a running Clawd Bot desktop instance to pair. **PLACEHOLDER — reviewer pairing method / test instance details.**
- **Wallet:** connects via Mobile Wallet Adapter / Seeker Connect; the app never sees private keys. Network: Solana devnet in this build.
- **Permissions:**
  - `CAMERA` — scan the pairing QR code only.
  - `INTERNET` — talk to the paired Clawd Bot and Solana RPC.
  - `POST_NOTIFICATIONS`, `VIBRATE` — bot activity and approval notifications.
  - Microphone, overlay and storage permissions are explicitly blocked.
- **Contact:** clawdbot@mail.grokbot.com
