import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During dev, point /api at whatever gateway server you run locally
// (default port 3010 from the Streamable HTTP example). In a production
// build, the dashboard is served from the same origin as the API so
// this proxy is irrelevant.
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: process.env.VITE_API_URL ?? 'http://localhost:3010',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
    },
})
