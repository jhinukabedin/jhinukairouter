import { useEffect, useState } from 'react';
import { api, ApiError, type AIModel, type Provider } from '../lib/api';
import { Layout } from '../components/Layout';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Table, Td } from '../components/Table';
import { Modal } from '../components/Modal';
import { Alert, ApiDownNote, Button, Checkbox, EmptyState, Field, Select, Spinner, TextInput } from '../components/forms';

export default function Models() {
  const [models, setModels] = useState<AIModel[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [form, setForm] = useState({
    providerId: '', modelId: '', displayName: '', contextWindow: 128000, maxOutputTokens: 4096,
    inputPricePer1M: 0, outputPricePer1M: 0, currency: 'USD',
    supportsStreaming: true, supportsTools: true, supportsVision: false, supportsReasoning: false, enabled: true,
  });

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [m, p] = await Promise.all([api.listModels(), api.listProviders()]);
      setModels(m);
      setProviders(p);
      if (!form.providerId && p.length > 0) setForm((f) => ({ ...f, providerId: p[0].id }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load models.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormErr('');
    try {
      await api.createModel({
        providerId: form.providerId, modelId: form.modelId, displayName: form.displayName || form.modelId,
        contextWindow: form.contextWindow, maxOutputTokens: form.maxOutputTokens,
        inputPricePer1M: form.inputPricePer1M, outputPricePer1M: form.outputPricePer1M, currency: form.currency,
        supportsStreaming: form.supportsStreaming, supportsTools: form.supportsTools,
        supportsVision: form.supportsVision, supportsReasoning: form.supportsReasoning, enabled: form.enabled,
      });
      setShowForm(false);
      await load();
    } catch (err) {
      setFormErr(err instanceof ApiError ? err.message : 'Could not add model.');
    }
  };

  const toggle = async (m: AIModel) => {
    await api.updateModel(m.id, { enabled: !m.enabled });
    await load();
  };

  return (
    <Layout title="Models">
      {error && <ApiDownNote error={error} />}
      <Card>
        <CardHeader
          title="Models"
          sub="Models added here appear in Routing Profiles pickers and in GET /v1/models immediately."
          actions={<Button onClick={() => setShowForm(true)}>+ Add model</Button>}
        />
        {loading ? <Spinner /> : models.length === 0 ? (
          <CardBody><EmptyState>No models yet. Add a provider first, then Sync Models — or add a model manually below.</EmptyState></CardBody>
        ) : (
          <Table headers={['Model', 'Provider', 'Context', 'In / Out price (per 1M)', 'Capabilities', 'Enabled', '']}>
            {models.map((m) => (
              <tr key={m.id} className="border-b border-slate-100 dark:border-slate-800">
                <Td><span className="font-medium">{m.displayName}</span><br /><span className="font-mono text-xs text-slate-500">{m.modelId}</span></Td>
                <Td>{m.provider?.name ?? m.providerId}</Td>
                <Td>{m.contextWindow.toLocaleString()}</Td>
                <Td>{m.pricing ? `${m.pricing.inputPricePer1M} / ${m.pricing.outputPricePer1M} ${m.pricing.currency}` : '—'}</Td>
                <Td className="text-xs">{[m.supportsStreaming && 'stream', m.supportsTools && 'tools', m.supportsVision && 'vision', m.supportsReasoning && 'reasoning'].filter(Boolean).join(', ') || '—'}</Td>
                <Td>{m.enabled ? 'Yes' : 'No'}</Td>
                <Td><Button variant="secondary" onClick={() => void toggle(m)}>{m.enabled ? 'Disable' : 'Enable'}</Button></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {showForm && (
        <Modal title="Add model — no code change, no redeploy" onClose={() => setShowForm(false)}>
          <form onSubmit={submit} className="space-y-4">
            {formErr && <Alert kind="error">{formErr}</Alert>}
            <Field label="Provider">
              <Select value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
              </Select>
            </Field>
            <Field label="Model ID" hint="The exact model id the provider expects, e.g. gpt-6-luna.">
              <TextInput required value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
            </Field>
            <Field label="Display name"><TextInput value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Context window (tokens)"><TextInput type="number" value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: Number(e.target.value) })} /></Field>
              <Field label="Max output tokens"><TextInput type="number" value={form.maxOutputTokens} onChange={(e) => setForm({ ...form, maxOutputTokens: Number(e.target.value) })} /></Field>
              <Field label="Input price / 1M"><TextInput type="number" step="0.0001" value={form.inputPricePer1M} onChange={(e) => setForm({ ...form, inputPricePer1M: Number(e.target.value) })} /></Field>
              <Field label="Output price / 1M"><TextInput type="number" step="0.0001" value={form.outputPricePer1M} onChange={(e) => setForm({ ...form, outputPricePer1M: Number(e.target.value) })} /></Field>
            </div>
            <Field label="Currency">
              <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                <option value="USD">USD</option>
                <option value="BDT">BDT</option>
              </Select>
            </Field>
            <div className="flex flex-wrap gap-4">
              <Checkbox label="Streaming" checked={form.supportsStreaming} onChange={(v) => setForm({ ...form, supportsStreaming: v })} />
              <Checkbox label="Tools" checked={form.supportsTools} onChange={(v) => setForm({ ...form, supportsTools: v })} />
              <Checkbox label="Vision" checked={form.supportsVision} onChange={(v) => setForm({ ...form, supportsVision: v })} />
              <Checkbox label="Reasoning" checked={form.supportsReasoning} onChange={(v) => setForm({ ...form, supportsReasoning: v })} />
              <Checkbox label="Enabled" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
            </div>
            <div className="flex gap-2">
              <Button type="submit">Add model</Button>
              <Button variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </form>
        </Modal>
      )}
    </Layout>
  );
}
