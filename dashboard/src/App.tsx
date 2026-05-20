import { useGateway } from './useGateway.js'
import type { CallLogEntry, ToolDescriptor } from './types.js'

export function App() {
    const { stats, tools, calls, online, lastUpdated, error } = useGateway()

    return (
        <div className="shell">
            <div className="header">
                <div>
                    <h1>mpp-mcp-gateway</h1>
                    <span className="muted">
                        Live revenue and call activity from the gateway's `/api` endpoints.
                    </span>
                </div>
                <div>
                    <span
                        className={
                            'status-dot ' + (online ? '' : error ? 'error' : 'warn')
                        }
                    />
                    <span className="muted mono">
                        {online
                            ? `online · ${formatRelative(lastUpdated)}`
                            : error
                                ? `disconnected: ${error}`
                                : 'connecting...'}
                    </span>
                </div>
            </div>

            <div className="grid">
                <Counter label="total revenue" value={stats ? `$${stats.totalRevenue}` : '—'} />
                <Counter
                    label="calls"
                    value={stats ? stats.totalCalls.toString() : '—'}
                    sub={
                        stats
                            ? `${stats.paidCalls} paid · ${stats.freeCalls} free · ${stats.accessKeyCalls} key · ${stats.sessionCalls} session`
                            : undefined
                    }
                />
                <Counter
                    label="access keys"
                    value={stats ? stats.accessKeysIssued.toString() : '—'}
                    sub={stats ? `${stats.accessKeysExpired} expired` : undefined}
                />
                <Counter
                    label="sessions"
                    value={stats ? stats.sessionsOpened.toString() : '—'}
                    sub={stats ? `${stats.sessionsClosed} closed` : undefined}
                />
            </div>

            <div className="section">
                <h2>tools</h2>
                <ToolTable tools={tools} stats={stats} />
            </div>

            <div className="section">
                <h2>recent calls</h2>
                <CallTable calls={calls} />
            </div>
        </div>
    )
}

function Counter({
    label,
    value,
    sub,
}: {
    label: string
    value: string
    sub?: string
}) {
    return (
        <div className="card">
            <div className="label">{label}</div>
            <div className="value mono">{value}</div>
            {sub ? <div className="sub mono">{sub}</div> : null}
        </div>
    )
}

function ToolTable({
    tools,
    stats,
}: {
    tools: ToolDescriptor[]
    stats: ReturnType<typeof useGateway>['stats']
}) {
    if (tools.length === 0) return <div className="empty">no tools registered</div>

    const rows = tools.map((t) => ({
        ...t,
        calls: stats?.callsByTool[t.name] ?? 0,
        revenue: stats?.revenueByTool[t.name] ?? '0',
    }))

    rows.sort((a, b) => parseFloat(b.revenue) - parseFloat(a.revenue))

    return (
        <table>
            <thead>
                <tr>
                    <th>name</th>
                    <th>price</th>
                    <th>calls</th>
                    <th>revenue</th>
                    <th>description</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((t) => (
                    <tr key={t.name}>
                        <td className="mono">{t.name}</td>
                        <td className="mono">{t.price ? `$${t.price}` : <span className="muted">free</span>}</td>
                        <td className="mono">{t.calls}</td>
                        <td className="mono">{t.revenue === '0' ? <span className="muted">—</span> : `$${t.revenue}`}</td>
                        <td className="muted">{t.description}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}

function CallTable({ calls }: { calls: CallLogEntry[] }) {
    if (calls.length === 0) {
        return <div className="empty">no activity yet — make a call to see it here</div>
    }
    return (
        <table>
            <thead>
                <tr>
                    <th>time</th>
                    <th>tool</th>
                    <th>mode</th>
                    <th>amount</th>
                    <th>duration</th>
                    <th>notes</th>
                </tr>
            </thead>
            <tbody>
                {calls.map((c, i) => (
                    <tr key={`${c.timestamp}-${i}`}>
                        <td className="mono muted">{shortTime(c.timestamp)}</td>
                        <td className="mono">{c.tool}</td>
                        <td>
                            <span className={'badge ' + (c.error ? 'error' : c.paymentMode)}>
                                {c.error ? 'error' : c.paymentMode}
                            </span>
                        </td>
                        <td className="mono">{c.amount ? `$${c.amount}` : <span className="muted">—</span>}</td>
                        <td className="mono">{c.durationMs}ms</td>
                        <td className="muted">
                            {c.error
                                ? c.error
                                : c.accessKeyJustIssued
                                    ? 'minted new access key'
                                    : ''}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}

function shortTime(iso: string): string {
    try {
        const d = new Date(iso)
        return d.toLocaleTimeString('en-US', { hour12: false })
    } catch {
        return iso
    }
}

function formatRelative(ts: number | null): string {
    if (ts === null) return ''
    const diff = Date.now() - ts
    if (diff < 1500) return 'just now'
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
    return `${Math.floor(diff / 60_000)}m ago`
}
