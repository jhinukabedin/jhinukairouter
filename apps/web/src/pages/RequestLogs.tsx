import { useEffect, useState } from 'react';
import { api, normalizePaged, type UsageRecord } from '../lib/api';
import { downloadCsv, toCsv } from '../lib/csv';
import { Layout } from '../components/Layout';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Table, Td } from '../components/Table';
import { ApiDownNote, Button, EmptyState, Field, Select, Spinner, TextInput } from '../components/forms';

export default function RequestLogs() {
  const [rows, setRows] = useState<UsageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async (p = 1) => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, string> = { page: String(p), limit: '25' };
      if (status) params.status = status;
      if (model) params.model = model;
      const paged = normalizePaged<UsageRecord>(await api.usageList(params));
      setRows(paged.data);
      setTotal(paged.total);
      setPage(paged.page);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load request logs.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(1); }, []);

  const exportCsv = () => {
    downloadCsv('request-logs.csv', toCsv(rows, [
      { key: 'createdAt', header: 'Date' }, { key: 'requestId', header: 'Request ID' },
      { key: 'provider', header: 'Provider' }, { key: 'model', header: 'Model' },
      { key: 'inputTokens', header: 'Tokens in' }, { key: 'outputTokens', header: 'Tokens out' },
      { key: 'latencyMs', header: 'Latency ms' }, { key: 'status', header: 'Status' },
    ]));
  };

  return (
    <Layout title="Request Logs">
      {error && <ApiDownNote error={error} />}
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All</option>
                <option value="SUCCESS">Success</option>
                <option value="FAILED">Failed</option>
              </Select>
            </Field>
            <Field label="Model contains"><TextInput value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. luna" /></Field>
            <Button onClick={() => void load(1)}>Apply</Button>
            <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>Export CSV (this page)</Button>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={`Requests — ${total.toLocaleString()} total`} sub="One row per gateway request, with the model that actually served it. No prompts are stored or shown." />
        {loading ? <Spinner /> : rows.length === 0 ? (
          <CardBody><EmptyState>No requests match these filters.</EmptyState></CardBody>
        ) : (
          <>
            <Table headers={['Date', 'Request ID', 'Provider / Model', 'Mode', 'Tokens', 'Latency', 'Status']}>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800">
                  <Td className="whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</Td>
                  <Td className="font-mono text-xs">{r.requestId}</Td>
                  <Td>{r.provider}/{r.model}</Td>
                  <Td>{r.routingMode ?? '—'}</Td>
                  <Td>{r.inputTokens} / {r.outputTokens}</Td>
                  <Td>{r.latencyMs} ms</Td>
                  <Td>{r.status === 'SUCCESS' ? '✓ Success' : '✗ Failed'}</Td>
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
    </Layout>
  );
}
