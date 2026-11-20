import { useEffect, useState } from 'react';
import { api, ApiError, type Provider } from '../lib/api';
import { PROVIDER_PRESETS } from '../lib/defaults';
import { Layout } from '../components/Layout';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Table, Td } from '../components/Table';
import { Modal } from '../components/Modal';
import { Alert, ApiDownNote, Button, Checkbox, EmptyState, Field, Select, Spinner, TextInput } from '../components/forms';

interface FormState {
  name: string; type: string; baseUrl: string; protocol: 'openai' | 'anthropic';
  apiKey: string; priority: number; timeoutMs: number; enabled: boolean;
}

export default function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>({
    name: '', type: 'tokens', baseUrl: 'https://tokens.bd/v1', protocol: 'openai',
    apiKey: '', priority: 100, timeoutMs: 30000, enabled: true,
  });
  const [formMsg, setFormMsg] = useState('');
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setProviders(await api.listProviders());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load providers.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const pickPreset = (type: string) => {
    const p = PROVIDER_PRESETS.find((x) => x.type === type);
    setForm((f) => ({ ...f, type, baseUrl: p?.baseUrl ?? '', protocol: p?.protocol ?? 'openai', name: f.name || p?.label || '' }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormErr('');
    setFormMsg('');
    setBusy(true);
    try {
      const created = await api.createProvider({
        name: form.name, type: form.type, baseUrl: form.baseUrl, protocol: form.protocol,
        apiKey: form.apiKey || undefined, priority: form.priority, timeoutMs: form.timeoutMs, enabled: form.enabled,
      });
      setFormMsg(`Provider "${created.name}" added. Test the connection, then Sync Models — the models will appear in Routing Profiles and GET /v1/models with no redeploy.`);
      setForm((f) => ({ ...f, apiKey: '' }));
      await load();
    } catch (err) {
      setFormErr(err instanceof ApiError ? err.message : 'Could not add provider.');
    } finally {
      setBusy(false);
    }
  };

  const test = async (p: Provider) => {
    try {
      const r = await api.testProvider(p.id);
      alert(r.ok ? `Connection OK${r.latencyMs ? ` (${r.latencyMs} ms)` : ''}.` : `Connection failed: ${r.error ?? 'unknown error'}`);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Test failed.');
    }
  };
  const sync = async (p: Provider) => {
    try {
      const r = await api.syncProviderModels(p.id);
      alert(`Synced ${r.synced} model(s)${r.models?.length ? `: ${r.models.join(', ')}` : ''}. They now appear in Routing Profiles pickers.`);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Sync failed.');
    }
  };

  return (
    <Layout title="Providers">
      {error && <ApiDownNote error={error} />}
      <Card>
        <CardHeader
          title="Providers"
          sub="API keys are stored encrypted on the server and are never shown back to the dashboard."
          actions={<Button onClick={() => { setShowForm(true); setFormMsg(''); setFormErr(''); }}>+ Add provider</Button>}
        />
        {loading ? <Spinner /> : providers.length === 0 ? (
          <CardBody><EmptyState>No providers yet. Add one — e.g. Tokens.bd — to start routing.</EmptyState></CardBody>
        ) : (
          <Table headers={['Name', 'Type', 'Base URL', 'Protocol', 'Priority', 'Enabled', 'Actions']}>
            {providers.map((p) => (
              <tr key={p.id} className="border-b border-slate-100 dark:border-slate-800">
                <Td>{p.name}{p.isGlobal ? ' (global)' : ''}</Td>
                <Td>{p.type}</Td>
                <Td className="max-w-56 truncate font-mono text-xs">{p.baseUrl}</Td>
                <Td>{p.protocol}</Td>
                <Td>{p.priority}</Td>
                <Td>{p.enabled ? 'Yes' : 'No'}</Td>
                <Td>
                  <div className="flex gap-1">
                    <Button variant="secondary" onClick={() => void test(p)}>Test</Button>
                    <Button variant="secondary" onClick={() => void sync(p)}>Sync models</Button>
                    <Button variant="danger" onClick={() => { if (confirm(`Delete provider ${p.name}?`)) void api.deleteProvider(p.id).then(load); }}>Delete</Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {showForm && (
        <Modal title="Add provider — one form, no code change" onClose={() => setShowForm(false)}>
          <form onSubmit={submit} className="space-y-4">
            {formErr && <Alert kind="error">{formErr}</Alert>}
            {formMsg && <Alert kind="success">{formMsg}</Alert>}
            <Field label="Provider type">
              <Select value={form.type} onChange={(e) => pickPreset(e.target.value)}>
                {PROVIDER_PRESETS.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
              </Select>
            </Field>
            <Field label="Name"><TextInput required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Tokens.bd" /></Field>
            <Field label="Base URL" hint="Custom providers: any OpenAI- or Anthropic-compatible endpoint. Localhost/private IPs are rejected unless the admin allows local providers.">
              <TextInput required value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://tokens.bd/v1" />
            </Field>
            <Field label="Protocol">
              <Select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value as 'openai' | 'anthropic' })}>
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic-compatible</option>
              </Select>
            </Field>
            <Field label="API key" hint="Sent once, stored encrypted (AES-256-GCM) on the server. Never displayed again.">
              <TextInput type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} autoComplete="off" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Priority"><TextInput type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} /></Field>
              <Field label="Timeout (ms)"><TextInput type="number" value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })} /></Field>
            </div>
            <Checkbox label="Enabled" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add provider'}</Button>
              <Button variant="secondary" onClick={() => setShowForm(false)}>Close</Button>
            </div>
            <p className="text-xs text-slate-500">After adding: use Test, then Sync Models on the provider row. New models appear immediately in Routing Profiles pickers and in GET /v1/models — no redeploy.</p>
          </form>
        </Modal>
      )}
    </Layout>
  );
}
