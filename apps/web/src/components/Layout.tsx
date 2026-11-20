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
  // Mobile nav: the sidebar is hidden below the md breakpoint, so phones get
  // a hamburger button + slide-over drawer with the same links.
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const close = () => setMenuOpen(false);
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, []);

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
      {/* Mobile drawer (phones/tablets): same links as the desktop sidebar. */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-label="Menu">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMenuOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 overflow-y-auto bg-white p-4 dark:bg-slate-900">
            <div className="flex items-start justify-between">
              <div>
                <a href="#/" className="block text-lg font-bold" onClick={() => setMenuOpen(false)}>Jhinuk AI Router</a>
                <p className="text-xs text-slate-500">Smart model routing</p>
              </div>
              <button
                onClick={() => setMenuOpen(false)}
                className="rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700"
                aria-label="Close menu"
              >
                ✕
              </button>
            </div>
            <nav className="mt-6 space-y-1">
              {NAV.map((n) => (
                <a
                  key={n.path}
                  href={n.path}
                  onClick={() => setMenuOpen(false)}
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
          </div>
        </div>
      )}
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
          <div className="flex min-w-0 items-center gap-2">
            <button
              onClick={() => setMenuOpen(true)}
              className="shrink-0 rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 md:hidden"
              aria-label="Open menu"
            >
              ☰ Menu
            </button>
            <h1 className="truncate text-lg font-semibold">{title}</h1>
          </div>
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
