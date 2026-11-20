import { useEffect, useState } from 'react';
import { api, normalizePaged, type UsageRecord, type UsageSummary, type CreditWallet, type HealthStatus } from '../lib/api';
import { Layout } from '../components/Layout';
import { Card, CardBody, CardHeader, Stat } from '../components/Card';
import { Table, Td } from '../components/Table';
import { Alert, ApiDownNote, EmptyState, Spinner } from '../components/forms';

const fmtMoney = (n: number) => `$${Number(n ?? 0).toFixed(4)}`;
const fmtNum = (n: number) => Number(n ?? 0).toLocaleString();

export default function Overview() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [wallet, setWallet] = useState<CreditWallet | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [recent, setRecent] = useState<UsageRecord[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [s, w, h, u] = await Promise.all([
          api.usageSummary({}).catch(() => null),
          api.wallet().catch(() => null),
          api.health().catch(() => null),
          api.usageList({ page: '1', limit: '10' }).catch(() => [] as UsageRecord[]),
        ]);
        setSummary(s);
        setWallet(w);
        setHealth(h);
        setRecent(normalizePaged<UsageRecord>(u).data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load overview.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Layout title="Overview"><Spinner /></Layout>;

  return (
    <Layout title="Overview">
      {error && <ApiDownNote error={error} />}
      {!summary && !error && (
        <Alert kind="info">Usage summary is not available yet — the API returned no summary. Recent requests below still come from the live API.</Alert>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total requests" value={fmtNum(summary?.totalRequests ?? 0)} sub="All time (API data)" />
        <Stat label="Routed requests" value={fmtNum(summary?.routedRequests ?? 0)} sub="Via routing profiles" />
        <Stat label="Tokens in / out" value={`${fmtNum(summary?.inputTokens ?? 0)} / ${fmtNum(summary?.outputTokens ?? 0)}`} sub={`${fmtNum(summary?.cachedTokens ?? 0)} cached`} />
        <Stat label="Tokens saved (RTK)" value={fmtNum(summary?.tokensSaved ?? 0)} sub="Prompt/context saving inside the gateway" />
        <Stat label="Est. provider cost" value={fmtMoney(summary?.estimatedCost ?? 0)} sub="From model pricing" />
        <Stat label="Platform credit used" value={fmtMoney(summary?.platformCharge ?? 0)} sub={`Balance: ${wallet ? `${wallet.balance.toFixed(2)} ${wallet.currency}` : '—'}`} />
        <Stat label="Error rate" value={`${((summary?.errorRate ?? 0) * 100).toFixed(1)}%`} sub={`Avg latency ${Math.round(summary?.avgLatencyMs ?? 0)} ms`} />
        <Stat label="Gateway health" value={health?.status ?? 'unknown'} sub={health ? `Uptime ${Math.round((health.uptimeSec ?? 0) / 60)} min` : 'Health endpoint not reachable'} />
      </div>

      <Card>
        <CardHeader title="Recent requests" sub="Latest 10, from the usage API" actions={<a href="#/logs" className="text-sm text-indigo-600">View all →</a>} />
        {recent.length === 0 ? (
          <CardBody><EmptyState>No requests yet. Send your first request through the gateway (see Client Setup).</EmptyState></CardBody>
        ) : (
          <Table headers={['Request', 'Provider / Model', 'Tokens in/out', 'Cost', 'Latency', 'Status']}>
            {recent.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800">
                <Td className="font-mono text-xs">{r.requestId.slice(0, 12)}…</Td>
                <Td>{r.provider}/{r.model}</Td>
                <Td>{fmtNum(r.inputTokens)} / {fmtNum(r.outputTokens)}</Td>
                <Td>{fmtMoney(r.estimatedCost)}</Td>
                <Td>{r.latencyMs} ms</Td>
                <Td>{r.status === 'SUCCESS' ? '✓ Success' : '✗ Failed'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Cost by model" sub="From the usage summary API" />
        {!summary?.byModel || summary.byModel.length === 0 ? (
          <CardBody><EmptyState>No model breakdown yet — it appears once requests have been logged.</EmptyState></CardBody>
        ) : (
          <Table headers={['Model', 'Requests', 'Tokens in', 'Tokens out', 'Cost']}>
            {summary.byModel.map((m) => (
              <tr key={m.model} className="border-b border-slate-100 dark:border-slate-800">
                <Td>{m.model}</Td>
                <Td>{fmtNum(m.requests)}</Td>
                <Td>{fmtNum(m.inputTokens)}</Td>
                <Td>{fmtNum(m.outputTokens)}</Td>
                <Td>{fmtMoney(m.cost)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Layout>
  );
}
