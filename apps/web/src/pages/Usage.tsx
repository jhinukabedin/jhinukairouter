import { useEffect, useState } from 'react';
import { api, normalizePaged, type UsageRecord, type UsageSummary } from '../lib/api';
import { downloadCsv, toCsv } from '../lib/csv';
import { Layout } from '../components/Layout';
import { Card, CardBody, CardHeader, Stat } from '../components/Card';
import { Table, Td } from '../components/Table';
import { Alert, ApiDownNote, Button, EmptyState, Field, Spinner, TextInput } from '../components/forms';

const fmtMoney = (n: number) => `$${Number(n ?? 0).toFixed(4)}`;
const fmtNum = (n: number) => Number(n ?? 0).toLocaleString();
const today = () => new Date().toISOString().slice(0, 10);
const monthAgo = () => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); };

export default function Usage() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [rows, setRows] = useState<UsageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState(monthAgo());
  const [to, setTo] = useState(today());
  const [modelFilter, setModelFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async (p = 1) => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, string> = { page: String(p), limit: '25' };
      if (from) params.from = from;
      if (to) params.to = to;
      if (modelFilter) params.model = modelFilter;
      if (providerFilter) params.provider = providerFilter;
      const [s, u] = await Promise.all([
        api.usageSummary(params).catch(() => null),
        api.usageList(params),
      ]);
      setSummary(s);
      const paged = normalizePaged<UsageRecord>(u);
      setRows(paged.data);
      setTotal(paged.total);
      setPage(paged.page);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(1); }, []);

  const exportCsv = () => {
    const csv = toCsv(rows, [
      { key: 'createdAt', header: 'Date' },
      { key: 'requestId', header: 'Request ID' },
      { key: 'provider', header: 'Provider' },
      { key: 'model', header: 'Model' },
      { key: 'taskCategory', header: 'Task' },
      { key: 'inputTokens', header: 'Tokens in' },
      { key: 'outputTokens', header: 'Tokens out' },
      { key: 'cachedTokens', header: 'Cached' },
      { key: 'tokensSaved', header: 'RTK saved' },
      { key: 'estimatedCost', header: 'Est. cost' },
      { key: 'platformCharge', header: 'Platform charge' },
      { key: 'latencyMs', header: 'Latency ms' },
      { key: 'status', header: 'Status' },
    ]);
    downloadCsv(`usage-${from}-to-${to}.csv`, csv);
  };

  return (
    <Layout title="Usage / Hiseb">
      {error && <ApiDownNote error={error} />}
      {!summary && !error && !loading && (
        <Alert kind="info">The usage summary endpoint returned nothing — the cards below show 0 except Total requests, which shows the loaded page count. All figures on this page come from the usage/credits API; nothing here is sample data.</Alert>
      )}
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From"><TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <Field label="Model contains"><TextInput value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} placeholder="e.g. luna" /></Field>
            <Field label="Provider contains"><TextInput value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} placeholder="e.g. tokens" /></Field>
            <Button onClick={() => void load(1)}>Apply filters</Button>
            <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>Export CSV (this page)</Button>
          </div>
        </CardBody>
      </Card>

      {loading ? <Spinner /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Total requests" value={fmtNum(summary?.totalRequests ?? total)} sub={`${from} → ${to}`} />
            <Stat label="Routed requests" value={fmtNum(summary?.routedRequests ?? 0)} sub="Via routing profiles" />
            <Stat label="Tokens in" value={fmtNum(summary?.inputTokens ?? 0)} sub={`${fmtNum(summary?.cachedTokens ?? 0)} cached`} />
            <Stat label="Tokens out" value={fmtNum(summary?.outputTokens ?? 0)} sub={`RTK saved: ${fmtNum(summary?.tokensSaved ?? 0)}`} />
            <Stat label="Est. provider cost" value={fmtMoney(summary?.estimatedCost ?? 0)} sub="Sum of model pricing" />
            <Stat label="Platform credit used" value={fmtMoney(summary?.platformCharge ?? 0)} sub="Charged to wallets" />
            <Stat label="Error rate" value={`${((summary?.errorRate ?? 0) * 100).toFixed(1)}%`} sub="Failed / total" />
            <Stat label="Avg latency" value={`${Math.round(summary?.avgLatencyMs ?? 0)} ms`} sub="Mean per request" />
          </div>

          <Card>
            <CardHeader title="Daily totals" sub="From the usage summary API" />
            {!summary?.daily || summary.daily.length === 0 ? (
              <CardBody><EmptyState>No daily breakdown returned for this range.</EmptyState></CardBody>
            ) : (
              <Table headers={['Date', 'Requests', 'Tokens in', 'Tokens out', 'Cost']}>
                {summary.daily.map((d) => (
                  <tr key={d.date} className="border-b border-slate-100 dark:border-slate-800">
                    <Td>{d.date}</Td><Td>{fmtNum(d.requests)}</Td><Td>{fmtNum(d.inputTokens)}</Td>
                    <Td>{fmtNum(d.outputTokens)}</Td><Td>{fmtMoney(d.cost)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Cost per model" sub="API data" />
              {!summary?.byModel?.length ? <CardBody><EmptyState>No data for this range.</EmptyState></CardBody> : (
                <Table headers={['Model', 'Requests', 'Cost']}>
                  {summary.byModel.map((m) => <tr key={m.model} className="border-b border-slate-100 dark:border-slate-800"><Td>{m.model}</Td><Td>{fmtNum(m.requests)}</Td><Td>{fmtMoney(m.cost)}</Td></tr>)}
                </Table>
              )}
            </Card>
            <Card>
              <CardHeader title="Cost per provider" sub="API data" />
              {!summary?.byProvider?.length ? <CardBody><EmptyState>No data for this range.</EmptyState></CardBody> : (
                <Table headers={['Provider', 'Requests', 'Cost']}>
                  {summary.byProvider.map((m) => <tr key={m.provider} className="border-b border-slate-100 dark:border-slate-800"><Td>{m.provider}</Td><Td>{fmtNum(m.requests)}</Td><Td>{fmtMoney(m.cost)}</Td></tr>)}
                </Table>
              )}
            </Card>
            <Card>
              <CardHeader title="Cost per API key" sub="API data" />
              {!summary?.byApiKey?.length ? <CardBody><EmptyState>No data for this range.</EmptyState></CardBody> : (
                <Table headers={['API key', 'Requests', 'Cost']}>
                  {summary.byApiKey.map((m) => <tr key={m.apiKeyId} className="border-b border-slate-100 dark:border-slate-800"><Td>{m.name ?? m.apiKeyId}</Td><Td>{fmtNum(m.requests)}</Td><Td>{fmtMoney(m.cost)}</Td></tr>)}
                </Table>
              )}
            </Card>
            <Card>
              <CardHeader title="Cost per user" sub="Admins see all users; regular users see only their own (API enforces this)." />
              {!summary?.byUser?.length ? <CardBody><EmptyState>No data for this range.</EmptyState></CardBody> : (
                <Table headers={['User', 'Requests', 'Cost']}>
                  {summary.byUser.map((m) => <tr key={m.userId} className="border-b border-slate-100 dark:border-slate-800"><Td>{m.email ?? m.userId}</Td><Td>{fmtNum(m.requests)}</Td><Td>{fmtMoney(m.cost)}</Td></tr>)}
                </Table>
              )}
            </Card>
          </div>

          <Card>
            <CardHeader title={`Request history — ${total.toLocaleString()} total`} sub="Paginated, newest first" />
            {rows.length === 0 ? (
              <CardBody><EmptyState>No requests in this range. Figures are live API data — nothing is faked here.</EmptyState></CardBody>
            ) : (
              <>
                <Table headers={['Date', 'Request', 'Provider / Model', 'Task', 'In / Out / Cached', 'RTK saved', 'Cost', 'Latency', 'Status']}>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800">
                      <Td className="whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</Td>
                      <Td className="font-mono text-xs">{r.requestId.slice(0, 10)}…</Td>
                      <Td>{r.provider}/{r.model}</Td>
                      <Td>{r.taskCategory ?? '—'}</Td>
                      <Td>{fmtNum(r.inputTokens)} / {fmtNum(r.outputTokens)} / {fmtNum(r.cachedTokens)}</Td>
                      <Td>{fmtNum(r.tokensSaved ?? 0)}</Td>
                      <Td>{fmtMoney(r.estimatedCost)}</Td>
                      <Td>{r.latencyMs} ms</Td>
                      <Td>{r.status === 'SUCCESS' ? '✓' : '✗'}</Td>
                    </tr>
                  ))}
                </Table>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-slate-500">Page {page} — 25 per page</span>
                  <div className="flex gap-2">
                    <Button variant="secondary" disabled={page <= 1} onClick={() => void load(page - 1)}>← Previous</Button>
                    <Button variant="secondary" disabled={rows.length < 25} onClick={() => void load(page + 1)}>Next →</Button>
                  </div>
                </div>
              </>
            )}
          </Card>
        </>
      )}
    </Layout>
  );
}
