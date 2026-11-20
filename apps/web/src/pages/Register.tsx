import { useState } from 'react';
import { api, setToken, ApiError } from '../lib/api';
import { Alert, Button, Field, TextInput } from '../components/forms';

export default function Register() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
      <form onSubmit={submit} className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Name"><TextInput value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
        <Field label="Email"><TextInput type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
        <Field label="Password"><TextInput type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
        <Button type="submit" disabled={busy} className="w-full">{busy ? 'Creating…' : 'Register'}</Button>
        <p className="text-sm text-slate-500">Already have an account? <a href="#/login" className="text-indigo-600">Sign in</a></p>
      </form>
    </div>
  );
}
