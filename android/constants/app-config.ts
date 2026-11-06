import { DappIdentity } from '@solana-mobile/seeker-connect-react-native'
import {
  createSolanaDevnet,
  createSolanaLocalnet,
  createSolanaTestnet,
  SolanaCluster,
} from '@wallet-ui/react-native-kit'

export class AppConfig {
  // MWA / Seeker Connect identity. The uri MUST be https — wallets show its host
  // during consent, and Seeker Connect ends the session for a custom scheme.
  // The icon resolves relative to this uri (https://clawdbot.party/favicon.ico).
  static identity: DappIdentity = { name: 'ClawdMobile', uri: 'https://clawdbot.party', icon: 'favicon.ico' }
  static networks: SolanaCluster[] = [
    createSolanaDevnet({ url: 'https://api.devnet.solana.com' }),
    createSolanaLocalnet({ url: 'http://localhost:8899' }),
    createSolanaTestnet({ url: 'https://api.testnet.solana.com' }),
    // Mainnet has no default public endpoint in Wallet UI — add it only with an
    // explicit RPC URL (the owner's own RPC), never a guessed one.
  ]
}
