import { useEffect, useState } from 'react';
import { api, setToken, ApiError } from '../lib/api';
import { Alert, Button, Field, TextInput } from '../components/forms';

export default function Register() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // When the admin has turned registration off, show a notice, not the form.
  // null = still loading the status; default to the form until we know.
  const [registrationEnabled, setRegistrationEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    api.registrationStatus().then((s) => setRegistrationEnabled(s.registrationEnabled)).catch(() => setRegistrationEnabled(true));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.register({ email, password, name: name || undefined });
      setToken(res.token);
      window.location.hash = '#/';
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Registration failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-16 max-w-md">
      <h1 className="text-2xl font-bold">Create an account</h1>
      <p className="mt-1 text-sm text-slate-500">Registration may be disabled by the admin (REGISTRATION_ENABLED).</p>
      {registrationEnabled === false ? (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <Alert kind="info">Registration is currently disabled by the admin. Ask the admin to turn it on, or sign in with an existing account.</Alert>
          <p className="mt-3 text-sm text-slate-500">Already have an account? <a href="#/login" className="text-indigo-600">Sign in</a></p>
        </div>
      ) : (
      <form onSubmit={submit} className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Name"><TextInput value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
        <Field label="Email"><TextInput type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
        <Field label="Password"><TextInput type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
        <Button type="submit" disabled={busy} className="w-full">{busy ? 'Creating…' : 'Register'}</Button>
        <p className="text-sm text-slate-500">Already have an account? <a href="#/login" className="text-indigo-600">Sign in</a></p>
      </form>
      )}
    </div>
  );
}
