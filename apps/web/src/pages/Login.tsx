import { useState } from 'react';
import { api, setToken, ApiError } from '../lib/api';
import { Alert, Button, Field, TextInput } from '../components/forms';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.login({ email, password, totpCode: totpCode || undefined });
      setToken(res.token);
      window.location.hash = '#/';
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-16 max-w-md">
      <h1 className="text-2xl font-bold">Jhinuk AI Router</h1>
      <p className="mt-1 text-sm text-slate-500">Sign in to the dashboard.</p>
      <form onSubmit={submit} className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Email"><TextInput type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
        <Field label="Password"><TextInput type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="2FA code (if enabled)" hint="Leave blank unless two-factor auth is on for your account.">
          <TextInput value={totpCode} onChange={(e) => setTotpCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
        </Field>
        <Button type="submit" disabled={busy} className="w-full">{busy ? 'Signing in…' : 'Sign in'}</Button>
        <p className="text-sm text-slate-500">No account? <a href="#/register" className="text-indigo-600">Register</a></p>
      </form>
    </div>
  );
}
