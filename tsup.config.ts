import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        server: 'src/server.ts',
        client: 'src/client.ts',
        dashboard: 'src/dashboard.ts',
        discovery: 'src/discovery.ts',
        stores: 'src/stores/index.ts',
        'rate-limit': 'src/rate-limit.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    target: 'node20',
})
