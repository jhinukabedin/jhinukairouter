import { useEffect, useState } from 'react';
import { api, normalizePaged, type AuditLog, type HealthStatus, type ProviderHealthItem, type SystemSetting, type User } from '../lib/api';
import { Layout } from '../components/Layout';
import { Card, CardBody, CardHeader, Stat } from '../components/Card';
import { Table, Td } from '../components/Table';
import { Alert, ApiDownNote, Button, EmptyState, Field, Spinner, TextInput } from '../components/forms';

type Tab = 'users' | 'roles' | 'providers' | 'pricing' | 'policies' | 'audit' | 'settings' | 'health';
const TABS: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Users' },
  { id: 'roles', label: 'Roles' },
  { id: 'providers', label: 'Providers' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'policies', label: 'Routing Policies' },
  { id: 'audit', label: 'Audit Logs' },
  { id: 'settings', label: 'System Settings' },
  { id: 'health', label: 'Health' },
];

export default function Admin() {
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<(User & { roles?: string[] })[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [providerHealth, setProviderHealth] = useState<ProviderHealthItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newName, setNewName] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [u, l, s, h, ph] = await Promise.all([
        api.adminUsers().catch(() => [] as (User & { roles?: string[] })[]),
        api.auditLogs({ page: '1', limit: '50' }).catch(() => [] as AuditLog[]),
        api.systemSettings().catch(() => [] as SystemSetting[]),
        api.health().catch(() => null),
        api.providerHealth().catch(() => [] as ProviderHealthItem[]),
      ]);
      setUsers(u);
      setLogs(normalizePaged<AuditLog>(l).data);
      setSettings(s);
      setHealth(h);
      setProviderHealth(ph);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load admin data.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg('');
    try {
      await api.adminCreateUser({ email: newEmail, password: newPassword, name: newName || undefined });
      setMsg(`User ${newEmail} created.`);
      setNewEmail(''); setNewPassword(''); setNewName('');
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not create user.');
    }
  };

  const toggleSuspend = async (u: User) => {
    try {
      if (u.status === 'ACTIVE') await api.adminSuspendUser(u.id);
      else await api.adminActivateUser(u.id);
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Action failed.');
    }
  };

  if (loading) return <Layout title="Admin"><Spinner /></Layout>;
  return (
    <Layout title="Admin">
      {error && <ApiDownNote error={error} />}
      {msg && <Alert kind="info">{msg}</Alert>}
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button key={t.id} variant={tab === t.id ? 'primary' : 'secondary'} onClick={() => setTab(t.id)}>{t.label}</Button>
        ))}
      </div>

      {tab === 'users' && (
        <Card>
          <CardHeader title="Users" sub="Admin only. Suspended users cannot sign in or use the gateway." />
          <CardBody>
            <form onSubmit={createUser} className="flex flex-wrap items-end gap-2">
              <Field label="Email"><TextInput type="email" required value={newEmail} onChange={(e) => setNewEmail(e.target.value)} /></Field>
              <Field label="Name"><TextInput value={newName} onChange={(e) => setNewName(e.target.value)} /></Field>
              <Field label="Password"><TextInput type="password" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></Field>
              <Button type="submit">Create user</Button>
            </form>
          </CardBody>
          {users.length === 0 ? <CardBody><EmptyState>No users returned (admin access required).</EmptyState></CardBody> : (
            <Table headers={['Email', 'Name', 'Roles', 'Status', 'Joined', '']}>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-slate-100 dark:border-slate-800">
                  <Td>{u.email}</Td><Td>{u.name ?? '—'}</Td><Td>{(u.roles ?? []).join(', ') || '—'}</Td>
                  <Td>{u.status}</Td><Td>{new Date(u.createdAt).toLocaleDateString()}</Td>
                  <Td><Button variant="secondary" onClick={() => void toggleSuspend(u)}>{u.status === 'ACTIVE' ? 'Suspend' : 'Activate'}</Button></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'roles' && (
        <Card>
          <CardHeader title="Roles" sub="Fixed roles from the contract: SUPER_ADMIN, ADMIN, MANAGER, USER, VIEWER." />
          <CardBody>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Role assignment is managed per user (see Users tab — roles are set at creation / update via the API).
              Permissions are fine-grained strings such as <code className="font-mono text-xs">providers:create</code>,{' '}
              <code className="font-mono text-xs">routing:update</code>, <code className="font-mono text-xs">credits:adjust</code>.
              There is no separate role-editing endpoint in the contract; role/permission rows are seeded by the API.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-5">
              {['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'USER', 'VIEWER'].map((r) => (
                <div key={r} className="rounded-lg border border-slate-200 p-3 text-center text-sm font-medium dark:border-slate-800">{r}</div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {tab === 'providers' && (
        <Card>
          <CardHeader title="Providers (admin view)" sub="Same provider list as the Providers page, with health below. Global providers serve all users." />
          <CardBody>
            <p className="text-sm">Manage providers on the <a href="#/providers" className="text-indigo-600">Providers page</a> — add, test, sync models, enable/disable. Provider health is on the Health tab.</p>
          </CardBody>
        </Card>
      )}

      {tab === 'pricing' && (
        <Card>
          <CardHeader title="Pricing" sub="Per-model input/output price (per 1M tokens) drives estimated cost and platform charges." />
          <CardBody>
            <p className="text-sm">Edit pricing per model on the <a href="#/models" className="text-indigo-600">Models page</a> (input/output price + currency, USD or BDT). The gateway uses the effective price at request time; price history is kept via ModelPricing.effectiveFrom / effectiveTo on the server.</p>
          </CardBody>
        </Card>
      )}

      {tab === 'policies' && (
        <Card>
          <CardHeader title="Routing Policies" sub="Global defaults that apply when a user profile does not override them." />
          <CardBody>
            <ul className="list-disc space-y-2 pl-5 text-sm">
              <li>Fallback triggers: 429, 5xx, timeout, unavailable — never 401/400, never mid-stream.</li>
              <li>Retry-After is respected before trying the next chain entry.</li>
              <li>Usage is recorded once per request, on the final outcome — never double-billed.</li>
              <li>Default task chains are the contract seed (Luna first for General, Kimi first for Code, GLM first for Architecture); each user edits their own in Routing Profiles.</li>
              <li>Per-user isolation is enforced by the API on every query.</li>
            </ul>
            <p className="mt-3 text-sm text-slate-500">Policy editing beyond these contract defaults is a server-side SystemSetting (see System Settings tab) — there is no separate policies endpoint in the contract.</p>
          </CardBody>
        </Card>
      )}

      {tab === 'audit' && (
        <Card>
          <CardHeader title="Audit Logs" sub="Latest 50 admin/audit events, from the API." />
          {logs.length === 0 ? <CardBody><EmptyState>No audit logs returned.</EmptyState></CardBody> : (
            <Table headers={['Date', 'Action', 'Resource', 'User', 'IP']}>
              {logs.map((l) => (
                <tr key={l.id} className="border-b border-slate-100 dark:border-slate-800">
                  <Td className="whitespace-nowrap">{new Date(l.createdAt).toLocaleString()}</Td>
                  <Td>{l.action}</Td><Td>{l.resource}{l.resourceId ? ` (${l.resourceId})` : ''}</Td>
                  <Td className="font-mono text-xs">{l.userId ?? '—'}</Td><Td>{l.ip ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'settings' && (
        <Card>
          <CardHeader title="System Settings" sub="Key/value settings (JSON). Edit the value and save — the API stores it." />
          {settings.length === 0 ? <CardBody><EmptyState>No system settings returned.</EmptyState></CardBody> : (
            <Table headers={['Key', 'Value', '']}>
              {settings.map((s) => (
                <tr key={s.key} className="border-b border-slate-100 dark:border-slate-800">
                  <Td className="font-mono text-xs">{s.key}</Td>
                  <Td><code className="break-all font-mono text-xs">{JSON.stringify(s.value)}</code></Td>
                  <Td>
                    <Button variant="secondary" onClick={() => {
                      const v = prompt(`New JSON value for ${s.key}:`, JSON.stringify(s.value));
                      if (v === null) return;
                      try {
                        const parsed = JSON.parse(v) as unknown;
                        void api.updateSystemSetting(s.key, parsed).then(load);
                      } catch { alert('Not valid JSON.'); }
                    }}>Edit</Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <CardBody>
            <p className="text-sm text-slate-500">Known keys include <code className="font-mono text-xs">allowLocalProviders</code> (true = allow localhost/private provider base URLs — admin only, SSRF guard off for those) and registration flags. Unknown keys are shown as returned by the API.</p>
          </CardBody>
        </Card>
      )}

      {tab === 'health' && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Stat label="API health" value={health?.status ?? 'unreachable'} sub={health ? `Uptime ${Math.round((health.uptimeSec ?? 0) / 60)} min` : 'GET /health did not answer'} />
            <Stat label="Database" value={health?.db ?? '—'} sub="From /health" />
            <Stat label="Redis" value={health?.redis ?? '—'} sub="Optional — router runs without it" />
          </div>
          <Card>
            <CardHeader title="Provider health" sub="Last check per provider, from the API." />
            {providerHealth.length === 0 ? <CardBody><EmptyState>No provider health data returned.</EmptyState></CardBody> : (
              <Table headers={['Provider', 'Status', 'Last latency', 'Error rate', 'Failures', 'Last checked']}>
                {providerHealth.map((p) => (
                  <tr key={p.providerId} className="border-b border-slate-100 dark:border-slate-800">
                    <Td>{p.providerName ?? p.providerId}</Td>
                    <Td>{p.status}</Td>
                    <Td>{p.lastLatencyMs != null ? `${p.lastLatencyMs} ms` : '—'}</Td>
                    <Td>{p.lastErrorRate != null ? `${(p.lastErrorRate * 100).toFixed(1)}%` : '—'}</Td>
                    <Td>{p.consecutiveFailures}</Td>
                    <Td>{p.lastCheckedAt ? new Date(p.lastCheckedAt).toLocaleString() : '—'}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </Layout>
  );
}
