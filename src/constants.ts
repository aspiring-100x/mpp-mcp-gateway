/**
 * Tempo network constants
 */

/** Tempo Testnet (Moderato) */
export const TEMPO_TESTNET = {
    chainId: 42431,
    name: 'Tempo Testnet (Moderato)',
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    wsUrl: 'wss://rpc.moderato.tempo.xyz',
    explorerUrl: 'https://explore.testnet.tempo.xyz',
} as const

/** Tempo Mainnet */
export const TEMPO_MAINNET = {
    chainId: 4217,
    name: 'Tempo Mainnet',
    rpcUrl: 'https://rpc.tempo.xyz',
    wsUrl: 'wss://rpc.tempo.xyz',
    explorerUrl: 'https://explore.tempo.xyz',
} as const

/** Default stablecoin addresses on testnet */
export const TESTNET_TOKENS = {
    pathUSD: '0x20c0000000000000000000000000000000000000' as `0x${string}`,
    alphaUSD: '0x20c0000000000000000000000000000000000001' as `0x${string}`,
    betaUSD: '0x20c0000000000000000000000000000000000002' as `0x${string}`,
    thetaUSD: '0x20c0000000000000000000000000000000000003' as `0x${string}`,
} as const

/** Default fee token (pathUSD) */
export const DEFAULT_CURRENCY = TESTNET_TOKENS.pathUSD

/** Tempo escrow contract addresses (used for session-priced tools). */
export const TEMPO_ESCROW_TESTNET =
    '0x542831e3E4Ace07559b7C8787395f4Fb99F70787' as `0x${string}`
export const TEMPO_ESCROW_MAINNET =
    '0x0901aED692C755b870F9605E56BAA66C35BEfF69' as `0x${string}`

/** Default gateway port */
export const DEFAULT_PORT = 3000

/** MCP `_meta` key used to attach an access-key authorization token. */
export const ACCESS_KEY_META = 'org.mppmcp/access-key'

/**
 * MCP `_meta` key used to carry the client's wallet fingerprint for
 * access-key binding verification. When `accessKeyBinding: 'wallet'`
 * is set on the server, the client must include this in every
 * access-key redemption request.
 */
export const ACCESS_KEY_FINGERPRINT_META = 'org.mppmcp/access-key-fingerprint'
