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

/**
 * Canonical TIP-1034 TIP-20 Channel Escrow precompile.
 *
 * Session pricing settles against this address on every Tempo chain, so it
 * is not network-specific. Current clients expect it, and the server
 * advertises it by default — leave `escrowContract` unset unless you have a
 * specific reason to pin a different one.
 */
export const TEMPO_CHANNEL_ESCROW =
    '0x4d50500000000000000000000000000000000000' as `0x${string}`

/**
 * Legacy per-network escrow **contract** addresses.
 *
 * @deprecated Superseded by {@link TEMPO_CHANNEL_ESCROW}. These predate the
 * TIP-1034 precompile and are retained only so deployments that explicitly
 * pinned them via `escrowContract` keep working. A server that advertises
 * one of these to a current client is rejected with an escrow mismatch,
 * because the client negotiates the precompile.
 */
export const TEMPO_ESCROW_TESTNET =
    '0xe1c4d3dce17bc111181ddf716f75bae49e61a336' as `0x${string}`
/** @deprecated See {@link TEMPO_ESCROW_TESTNET}. */
export const TEMPO_ESCROW_MAINNET =
    '0x33b901018174DDabE4841042ab76ba85D4e24f25' as `0x${string}`

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
