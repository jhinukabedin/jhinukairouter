import { useEffect, useMemo, useState } from 'react';
import { api, testGatewayChat, ApiError, type AIModel, type RoutingMode, type RoutingProfile } from '../lib/api';
import { addChainEntry, chainLabel, moveChainEntry, normalizeChain, removeChainEntry, type ChainEntry } from '../lib/chain';
import { AGENTS, DEFAULT_CHAINS, SEED_MODELS, TASKS, seedDisplayName } from '../lib/defaults';
import { Layout } from '../components/Layout';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Alert, ApiDownNote, Button, EmptyState, Field, Select, Spinner, TextInput } from '../components/forms';

type Mapping = Record<string, ChainEntry[]>;

function mappingFrom(profile: RoutingProfile | null): Mapping {
  const out: Mapping = {};
  for (const t of TASKS) {
    const v = profile?.taskMapping?.[t.category];
    const chain = normalizeChain(v);
    out[t.category] = chain.length > 0 ? chain : (DEFAULT_CHAINS[t.category] ?? []);
  }
  return out;
}

export default function RoutingProfiles() {
  const [profiles, setProfiles] = useState<RoutingProfile[]>([]);
  const [activeId, setActiveId] = useState('');
  const [mode, setMode] = useState<RoutingMode>('AUTOMATIC');
  const [mapping, setMapping] = useState<Mapping>(() => mappingFrom(null));
  const [isDefault, setIsDefault] = useState(true);
  const [budget, setBudget] = useState('');
  const [models, setModels] = useState<AIModel[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [testResult, setTestResult] = useState('');
  const [testing, setTesting] = useState('');
  const [newName, setNewName] = useState('');
  // The gateway only accepts router API keys, not the dashboard session
  // token (0.1.5: Test always 401'd before this). Kept in this browser only.
  const [routerKey, setRouterKey] = useState(() => localStorage.getItem('jar_router_test_key') ?? '');
  const saveRouterKey = (k: string) => {
    setRouterKey(k);
    if (k) localStorage.setItem('jar_router_test_key', k);
    else localStorage.removeItem('jar_router_test_key');
  };

  const active = profiles.find((p) => p.id === activeId) ?? null;

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [ps, ms] = await Promise.all([api.listProfiles(), api.listModels().catch(() => [] as AIModel[])]);
      setProfiles(ps);
      setModels(ms);
      const def = ps.find((p) => p.isDefault) ?? ps[0] ?? null;
      if (def) {
        setActiveId(def.id);
        setMode(def.mode);
        setMapping(mappingFrom(def));
        setIsDefault(def.isDefault);
        setBudget(def.budgetDailyCredits != null ? String(def.budgetDailyCredits) : '');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load routing profiles.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const pickOptions = useMemo(() => {
    if (models.length > 0) {
      return models.map((m) => ({
        ref: `${m.provider?.type ?? ''}/${m.modelId}`,
        label: `${m.displayName} (${m.provider?.type ?? '?'}/${m.modelId})${m.enabled ? '' : ' — disabled'}`,
        provider: m.provider?.type ?? '',
        model: m.modelId,
      }));
    }
    return SEED_MODELS.map((m) => ({ ref: `${m.provider}/${m.model}`, label: `${m.displayName} (${m.provider}/${m.model})`, provider: m.provider, model: m.model }));
  }, [models]);

  const selectProfile = (id: string) => {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    setActiveId(id);
    setMode(p.mode);
    setMapping(mappingFrom(p));
    setIsDefault(p.isDefault);
    setBudget(p.budgetDailyCredits != null ? String(p.budgetDailyCredits) : '');
    setMsg('');
    setTestResult('');
  };

  const updateChain = (task: string, fn: (c: ChainEntry[]) => ChainEntry[]) =>
    setMapping((m) => ({ ...m, [task]: fn(m[task] ?? []) }));

  const save = async () => {
    if (!active) return;
    setSaving(true);
    setMsg('');
    try {
      await api.updateProfile(active.id, {
        mode, taskMapping: mapping, isDefault,
        budgetDailyCredits: budget ? Number(budget) : null,
      });
      setMsg('Profile saved. Every client using the router aliases picks up the new chains immediately — no client change needed.');
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const createProfile = async () => {
    if (!newName.trim()) return;
    try {
      const p = await api.createProfile({ name: newName.trim(), mode: 'AUTOMATIC', taskMapping: DEFAULT_CHAINS, isDefault: profiles.length === 0 });
      setNewName('');
      await load();
      selectProfile(p.id);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Could not create profile.');
    }
  };

  const testEntry = async (task: string, entry: ChainEntry) => {
    const key = `${task}:${entry.provider}/${entry.model}`;
    setTesting(key);
    setTestResult('');
    if (!routerKey.trim()) {
      setTestResult('✗ Paste a router API key below first (create one on the API Keys page) — the gateway does not accept the dashboard login for tests.');
      setTesting('');
      return;
    }
    try {
      // Test via the gateway using the alias-free model ref; the router resolves
      // the chain and reports which model actually served the request.
      const r = await testGatewayChat(`${entry.provider}/${entry.model}`, routerKey.trim());
      setTestResult(`✓ ${entry.provider}/${entry.model} answered via ${r.provider}/${r.model}: “${r.content.trim().slice(0, 120)}”`);
    } catch (e) {
      setTestResult(`✗ Test failed for ${entry.provider}/${entry.model}: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setTesting('');
    }
  };

  const testChain = async (task: string) => {
    const chain = mapping[task] ?? [];
    if (chain.length === 0) return;
    const key = `${task}:chain`;
    setTesting(key);
    setTestResult('');
    if (!routerKey.trim()) {
      setTestResult('✗ Paste a router API key below first (create one on the API Keys page) — the gateway does not accept the dashboard login for tests.');
      setTesting('');
      return;
    }
    try {
      const first = chain[0];
      const r = await testGatewayChat(`${first.provider}/${first.model}`, routerKey.trim());
      setTestResult(`✓ Chain for ${task} served by ${r.provider}/${r.model} (first available in chain). Full fallback (429/5xx/timeout) is exercised by the gateway, not the dashboard.`);
    } catch (e) {
      setTestResult(`✗ Chain test failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setTesting('');
    }
  };

  if (loading) return <Layout title="Routing Profiles"><Spinner /></Layout>;

  return (
    <Layout title="Routing Profiles">
      {error && <ApiDownNote error={error} />}
      {msg && <Alert kind={msg.startsWith('✓') || msg.includes('saved') ? 'success' : 'info'}>{msg}</Alert>}
      {testResult && <Alert kind={testResult.startsWith('✓') ? 'success' : 'error'}>{testResult}</Alert>}

      <Card>
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Router API key (for Test buttons)">
              <TextInput type="password" value={routerKey} onChange={(e) => saveRouterKey(e.target.value)} placeholder="rk_live_…" autoComplete="off" />
            </Field>
          </div>
          <p className="mt-2 text-xs text-slate-500">The gateway only accepts router API keys, not your dashboard login. Create one on the API Keys page and paste it here — it stays in this browser only.</p>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Profile">
              <Select value={activeId} onChange={(e) => selectProfile(e.target.value)}>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}{p.isDefault ? ' (default)' : ''}</option>)}
              </Select>
            </Field>
            <Field label="Mode">
              <Select value={mode} onChange={(e) => setMode(e.target.value as RoutingMode)}>
                <option value="AUTOMATIC">Automatic — router picks the best chain entry</option>
                <option value="MANUAL">Manual — always use the first chain entry, no auto-switch</option>
                <option value="HYBRID">Hybrid — automatic, but prefer your pinned provider</option>
              </Select>
            </Field>
            <Field label="Daily budget (credits, optional)">
              <TextInput type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 500" />
            </Field>
            <Button onClick={() => void save()} disabled={saving || !active}>{saving ? 'Saving…' : 'Save profile'}</Button>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="New profile name"><TextInput value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Cheap-first" /></Field>
            <Button variant="secondary" onClick={() => void createProfile()}>Create profile</Button>
            {active && <Button variant="danger" onClick={() => { if (confirm(`Delete profile "${active.name}"?`)) void api.deleteProfile(active.id).then(load); }}>Delete profile</Button>}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Mode meanings: <b>Automatic</b> — the router scores the chain and falls back on 429 / 5xx / timeout / unavailable.
            <b> Manual</b> — only the first entry is used. <b>Hybrid</b> — automatic fallback, but your preferred provider is tried first when available.
            Fallback never retries 401/400 and never switches model after the first streamed chunk.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Per-agent chains — OpenCode agents"
          sub="Each agent maps to a router alias (coordinator, fast, coder, developer, reasoner, architect). The alias IS the chain: edit it once here and every agent using it picks it up."
        />
        <CardBody>
          {AGENTS.map((a) => (
            <ChainEditor
              key={a.id}
              title={`${a.label} agent → alias “${a.id}”`}
              sub={a.description}
              chain={mapping[a.task] ?? []}
              options={pickOptions}
              onChange={(fn) => updateChain(a.task, fn)}
              onTestEntry={(e) => void testEntry(a.task, e)}
              onTestChain={() => void testChain(a.task)}
              testing={testing.startsWith(`${a.task}:`)}
              taskKey={a.task}
            />
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Per-task chains — all task categories"
          sub="Requests that carry a taskCategory (or are classified by the router) use these chains. Same ordered-list rules as above."
        />
        <CardBody>
          {TASKS.map((t) => (
            <ChainEditor
              key={t.category}
              title={`${t.label} (${t.category})`}
              sub={t.hint}
              chain={mapping[t.category] ?? []}
              options={pickOptions}
              onChange={(fn) => updateChain(t.category, fn)}
              onTestEntry={(e) => void testEntry(t.category, e)}
              onTestChain={() => void testChain(t.category)}
              testing={testing.startsWith(`${t.category}:`)}
              taskKey={t.category}
            />
          ))}
        </CardBody>
      </Card>
    </Layout>
  );
}

function ChainEditor({
  title, sub, chain, options, onChange, onTestEntry, onTestChain, testing, taskKey,
}: {
  title: string; sub: string; chain: ChainEntry[];
  options: { ref: string; label: string; provider: string; model: string }[];
  onChange: (fn: (c: ChainEntry[]) => ChainEntry[]) => void;
  onTestEntry: (e: ChainEntry) => void; onTestChain: () => void;
  testing: boolean; taskKey: string;
}) {
  const [pick, setPick] = useState(options[0]?.ref ?? '');
  useEffect(() => { if (!pick && options[0]) setPick(options[0].ref); }, [options, pick]);

  return (
    <div className="mb-5 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-xs text-slate-500">{sub}</p>
        </div>
        <Button variant="secondary" onClick={onTestChain} disabled={testing || chain.length === 0}>
          {testing ? 'Testing…' : 'Test chain'}
        </Button>
      </div>
      <p className="mt-2 text-sm">
        Fallback chain: <span className="font-medium">{chainLabel(chain, seedDisplayName)}</span>
      </p>
      {chain.length === 0 ? (
        <EmptyState>No model in this chain — requests for this agent/task will fail. Add at least one model.</EmptyState>
      ) : (
        <ol className="mt-2 space-y-1">
          {chain.map((e, i) => (
            <li key={`${e.provider}/${e.model}`} className="flex flex-wrap items-center gap-2 rounded bg-slate-50 px-2 py-1.5 text-sm dark:bg-slate-800">
              <span className="w-6 text-center font-bold text-indigo-600">#{i + 1}</span>
              <span className="font-medium">{seedDisplayName(e)}</span>
              <span className="font-mono text-xs text-slate-500">{e.provider}/{e.model}</span>
              {i === 0 && <span className="rounded bg-indigo-100 px-1.5 text-xs text-indigo-700 dark:bg-indigo-950">primary</span>}
              <span className="ml-auto flex gap-1">
                <Button variant="ghost" onClick={() => onChange((c) => moveChainEntry(c, i, -1))} disabled={i === 0}>↑</Button>
                <Button variant="ghost" onClick={() => onChange((c) => moveChainEntry(c, i, 1))} disabled={i === chain.length - 1}>↓</Button>
                <Button variant="ghost" onClick={() => onTestEntry(e)}>Test</Button>
                <Button variant="ghost" onClick={() => onChange((c) => removeChainEntry(c, i))}>Remove</Button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Select value={pick} onChange={(e) => setPick(e.target.value)} className="max-w-xs">
          {options.map((o) => <option key={o.ref} value={o.ref}>{o.label}</option>)}
        </Select>
        <Button
          variant="secondary"
          onClick={() => {
            const o = options.find((x) => x.ref === pick);
            if (o) onChange((c) => addChainEntry(c, { provider: o.provider, model: o.model }));
          }}
        >
          + Add to chain
        </Button>
        <span className="self-center text-xs text-slate-500" data-task={taskKey}>
          New models added in Providers / Models appear in this picker after a refresh.
        </span>
      </div>
    </div>
  );
}
