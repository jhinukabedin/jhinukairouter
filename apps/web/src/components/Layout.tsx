import { useEffect, useState, type ReactNode } from 'react';
import { api, clearToken, getToken, type User } from '../lib/api';

export const NAV: { path: string; label: string }[] = [
  { path: '#/', label: 'Overview' },
  { path: '#/providers', label: 'Providers' },
  { path: '#/models', label: 'Models' },
  { path: '#/api-keys', label: 'API Keys' },
  { path: '#/routing', label: 'Routing Profiles' },
  { path: '#/usage', label: 'Usage / Hiseb' },
  { path: '#/credits', label: 'Credits' },
  { path: '#/logs', label: 'Request Logs' },
  { path: '#/client-setup', label: 'Client Setup' },
  { path: '#/settings', label: 'Settings' },
  { path: '#/admin', label: 'Admin' },
];

export function Layout({ title, children }: { title: string; children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem('jar_theme') === 'dark');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('jar_theme', dark ? 'dark' : 'light');
  }, [dark]);

  useEffect(() => {
    if (!getToken()) return;
    api.me().then(setUser).catch(() => undefined);
  }, []);

  const logout = async () => {
    try { await api.logout(); } catch { /* ignore */ }
    clearToken();
    window.location.hash = '#/login';
    window.location.reload();
  };

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 md:block">
        <a href="#/" className="block text-lg font-bold">Jhinuk AI Router</a>
        <p className="text-xs text-slate-500">Smart model routing</p>
        <nav className="mt-6 space-y-1">
          {NAV.map((n) => (
            <a
              key={n.path}
              href={n.path}
              className={`block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 ${
                window.location.hash === n.path || (n.path === '#/' && (window.location.hash === '' || window.location.hash === '#/'))
                  ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-slate-800 dark:text-indigo-300'
                  : ''
              }`}
            >
              {n.label}
            </a>
          ))}
        </nav>
        <div className="mt-8 text-xs text-slate-400">
          <p>Gateway: router.developersbd.top/v1</p>
          <p className="mt-1">Local dev: localhost:3001/v1</p>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
          <h1 className="truncate text-lg font-semibold">{title}</h1>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => setDark(!dark)}
              className="rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700"
              aria-label="Toggle dark mode"
            >
              {dark ? '☀ Light' : '🌙 Dark'}
            </button>
            {user && <span className="hidden text-sm text-slate-500 sm:inline">{user.email}</span>}
            <button onClick={logout} className="rounded-lg bg-slate-200 px-2 py-1 text-sm dark:bg-slate-700">Log out</button>
          </div>
        </header>
        <main className="mx-auto max-w-6xl space-y-4 p-4">{children}</main>
      </div>
    </div>
  );
}
