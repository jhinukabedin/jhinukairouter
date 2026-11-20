import { useEffect, useState } from 'react';
import { api, ApiError, type ApiKeyItem } from '../lib/api';
import { Layout } from '../components/Layout';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Table, Td } from '../components/Table';
import { Alert, ApiDownNote, Button, EmptyState, Field, Spinner, TextInput } from '../components/forms';

export default function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setKeys(await api.listApiKeys());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load API keys.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg('');
    try {
      const k = await api.createApiKey({ name });
      setNewKey(k.key ?? '');
      setMsg('Key created — copy it now. It will never be shown again.');
      setName('');
      await load();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Could not create key.');
    }
  };

  const regenerate = async (k: ApiKeyItem) => {
    if (!confirm(`Regenerate key "${k.name}"? The old key stops working immediately.`)) return;
    try {
      const r = await api.regenerateApiKey(k.id);
      setNewKey(r.key ?? '');
      setMsg('Key regenerated — copy the new key now. It will never be shown again.');
      await load();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Regeneration failed.');
    }
  };

  return (
    <Layout title="API Keys">
      {error && <ApiDownNote error={error} />}
      {newKey && (
        <Alert kind="success">
          <p className="font-medium">Your new key (shown once only):</p>
          <code className="mt-1 block break-all rounded bg-white/60 p-2 font-mono text-xs dark:bg-black/40">{newKey}</code>
          <p className="mt-1">Store it in your client config now. The dashboard cannot show it again.</p>
        </Alert>
      )}
      {msg && !newKey && <Alert kind="info">{msg}</Alert>}
      <Card>
        <CardHeader title="Router API keys" sub="Use as: Authorization: Bearer &lt;key&gt; against the gateway. Only the prefix is stored visibly." />
        <CardBody>
          <form onSubmit={create} className="flex flex-wrap items-end gap-2">
            <Field label="Key name"><TextInput required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. OpenCode on PC" /></Field>
            <Button type="submit">Create key</Button>
          </form>
        </CardBody>
        {loading ? <Spinner /> : keys.length === 0 ? (
          <CardBody><EmptyState>No API keys yet. Create one to connect a client.</EmptyState></CardBody>
        ) : (
          <Table headers={['Name', 'Prefix', 'Last used', 'Expires', 'Status', 'Actions']}>
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-slate-100 dark:border-slate-800">
                <Td>{k.name}</Td>
                <Td className="font-mono text-xs">{k.keyPrefix}…</Td>
                <Td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'Never'}</Td>
                <Td>{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'Never'}</Td>
                <Td>{k.revokedAt ? 'Revoked' : 'Active'}</Td>
                <Td>
                  <div className="flex gap-1">
                    <Button variant="secondary" onClick={() => void regenerate(k)}>Regenerate</Button>
                    <Button variant="danger" onClick={() => { if (confirm(`Delete key "${k.name}"?`)) void api.deleteApiKey(k.id).then(load); }}>Delete</Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Layout>
  );
}
