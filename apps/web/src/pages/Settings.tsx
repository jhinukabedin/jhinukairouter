import { useEffect, useState } from 'react';
import { api, type SessionItem, type User } from '../lib/api';
import { Layout } from '../components/Layout';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Table, Td } from '../components/Table';
import { Alert, ApiDownNote, Button, EmptyState, Field, Spinner, TextInput } from '../components/forms';

export default function Settings() {
  const [user, setUser] = useState<User | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [totpCode, setTotpCode] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [u, s] = await Promise.all([api.me(), api.sessions()]);
      setUser(u);
      setSessions(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load settings.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  if (loading) return <Layout title="Settings"><Spinner /></Layout>;
  return (
    <Layout title="Settings">
      {error && <ApiDownNote error={error} />}
      {msg && <Alert kind="info">{msg}</Alert>}
      <Card>
        <CardHeader title="Account" sub="Your profile, as stored by the API." />
        <CardBody>
          {user ? (
            <dl className="space-y-1 text-sm">
              <div><dt className="inline font-medium">Email: </dt><dd className="inline">{user.email}</dd></div>
              <div><dt className="inline font-medium">Name: </dt><dd className="inline">{user.name ?? '—'}</dd></div>
              <div><dt className="inline font-medium">Status: </dt><dd className="inline">{user.status}</dd></div>
              <div><dt className="inline font-medium">Joined: </dt><dd className="inline">{new Date(user.createdAt).toLocaleString()}</dd></div>
            </dl>
          ) : <EmptyState>Could not load your profile.</EmptyState>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Two-factor authentication (TOTP)" sub="Enable with an authenticator app. The secret is shown once during setup." />
        <CardBody>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.totpVerify(totpCode);
                setMsg('2FA code verified.');
              } catch (err) {
                setMsg(err instanceof Error ? err.message : 'Verification failed.');
              }
            }}
          >
            <Button variant="secondary" onClick={() => { void api.totpSetup().then((r) => setMsg(`Setup started. Secret (store it safely, shown once): ${r.secret}`)); }}>
              Start TOTP setup
            </Button>
            <Field label="Verify code"><TextInput value={totpCode} onChange={(e) => setTotpCode(e.target.value)} inputMode="numeric" /></Field>
            <Button type="submit">Verify</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Sessions" sub="Active logins for your account. Revoke any you do not recognise." />
        {sessions.length === 0 ? (
          <CardBody><EmptyState>No other sessions listed.</EmptyState></CardBody>
        ) : (
          <Table headers={['Session', 'IP', 'Expires', '']}>
            {sessions.map((s) => (
              <tr key={s.id} className="border-b border-slate-100 dark:border-slate-800">
                <Td>{s.userAgent ?? s.id}</Td>
                <Td>{s.ip ?? '—'}</Td>
                <Td>{new Date(s.expiresAt).toLocaleString()}</Td>
                <Td><Button variant="danger" onClick={() => { void api.revokeSession(s.id).then(load); }}>Revoke</Button></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Layout>
  );
}
