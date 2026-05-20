import { useEffect, useRef, useState } from 'react'
import type { CallLogEntry, GatewayStats, ToolDescriptor } from './types.js'

const REFRESH_MS = 2000

type GatewayState = {
    stats: GatewayStats | null
    tools: ToolDescriptor[]
    calls: CallLogEntry[]
    lastUpdated: number | null
    online: boolean
    error: string | null
}

const initialState: GatewayState = {
    stats: null,
    tools: [],
    calls: [],
    lastUpdated: null,
    online: false,
    error: null,
}

/**
 * Polls /api/stats, /api/tools, /api/calls every REFRESH_MS and exposes a
 * single state object. On error it preserves the last good snapshot but
 * marks `online: false` so the UI can show a connection-lost banner.
 */
export function useGateway(): GatewayState {
    const [state, setState] = useState<GatewayState>(initialState)
    const cancelled = useRef(false)

    useEffect(() => {
        cancelled.current = false
        let timer: ReturnType<typeof setTimeout> | undefined

        const tick = async () => {
            try {
                const [statsRes, toolsRes, callsRes] = await Promise.all([
                    fetch('/api/stats'),
                    fetch('/api/tools'),
                    fetch('/api/calls?limit=200'),
                ])
                if (!statsRes.ok || !toolsRes.ok || !callsRes.ok) {
                    throw new Error(`HTTP ${statsRes.status}/${toolsRes.status}/${callsRes.status}`)
                }
                const [{ stats }, { tools }, { calls }] = await Promise.all([
                    statsRes.json() as Promise<{ stats: GatewayStats }>,
                    toolsRes.json() as Promise<{ tools: ToolDescriptor[] }>,
                    callsRes.json() as Promise<{ calls: CallLogEntry[] }>,
                ])
                if (cancelled.current) return
                setState({
                    stats,
                    tools,
                    calls,
                    lastUpdated: Date.now(),
                    online: true,
                    error: null,
                })
            } catch (err) {
                if (cancelled.current) return
                setState((prev) => ({
                    ...prev,
                    online: false,
                    error: err instanceof Error ? err.message : 'fetch failed',
                }))
            }
            if (!cancelled.current) {
                timer = setTimeout(tick, REFRESH_MS)
            }
        }

        void tick()
        return () => {
            cancelled.current = true
            if (timer) clearTimeout(timer)
        }
    }, [])

    return state
}
