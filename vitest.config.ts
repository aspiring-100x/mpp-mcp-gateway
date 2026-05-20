import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // These tests spawn in-memory MCP transports and occasionally sign
        // real Tempo-testnet transactions, so give each a generous window.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        // Run sequentially — the integration test shares a testnet RPC and
        // recipient wallet, so isolating runs avoids nonce collisions.
        fileParallelism: false,
    },
})
