import { useState } from 'react';
import { GATEWAY_LOCAL_URL, GATEWAY_PROD_URL, testGatewayConnection } from '../lib/api';
import { AGENTS, ROUTER_ALIASES } from '../lib/defaults';
import { chainLabel } from '../lib/chain';
import { seedDisplayName } from '../lib/defaults';
import { Layout } from '../components/Layout';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Table, Td } from '../components/Table';
import { Alert, Button, CodeBlock, Field, Select, TextInput } from '../components/forms';

type ClientId = 'opencode' | 'claude-code' | 'vscode' | 'aider' | 'generic';
const CLIENTS: { id: ClientId; label: string; desc: string }[] = [
  { id: 'opencode', label: 'OpenCode', desc: 'Router as base URL, per-agent aliases, RTK plugin keeps working.' },
  { id: 'claude-code', label: 'Claude Code', desc: 'Anthropic-compatible endpoint via the router.' },
  { id: 'vscode', label: 'VS Code — Continue / Cline / Roo', desc: 'OpenAI-compatible provider pointing at the router.' },
  { id: 'aider', label: 'Aider', desc: 'OpenAI-compatible via environment variables.' },
  { id: 'generic', label: 'Generic OpenAI / Anthropic client', desc: 'Any client that speaks the OpenAI chat API, plus curl.' },
];

function opencodeJson(baseUrl: string, useRouter: boolean): string {
  if (!useRouter) {
    // Direct per-agent model lists for non-router users (contract requirement).
    return JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        tokens: { npm: '@ai-sdk/openai-compatible', name: 'Tokens', options: { baseURL: 'https://tokens.bd/v1' } },
      },
      agent: {
        coordinator: { model: 'tokens/gpt-6-luna', prompt: 'You are the coordinator. Plan, delegate to subagents, verify results.' },
        fast: { model: 'tokens/gpt-6-luna' },
        coder: { model: 'tokens/gpt-6-luna' },
        developer: { model: 'tokens/gpt-6-luna' },
        reasoner: { model: 'tokens/gpt-6-luna' },
        architect: { model: 'tokens/gpt-6-luna' },
      },
    }, null, 2);
  }
  const agents: Record<string, { model: string; prompt?: string }> = {};
  for (const a of AGENTS) {
    agents[a.id] = { model: `router/${a.id}` };
  }
  agents.coordinator.prompt = 'You are the coordinator. Plan, delegate to subagents, verify results.';
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      router: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Jhinuk AI Router',
        options: { baseURL: baseUrl },
      },
    },
    agent: agents,
  }, null, 2);
}

export default function ClientSetup() {
  const [client, setClient] = useState<ClientId>('opencode');
  const [env, setEnv] = useState<'prod' | 'local'>('prod');
  const [useRouter, setUseRouter] = useState(true);
  const [testKey, setTestKey] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [testing, setTesting] = useState(false);

  const baseUrl = env === 'prod' ? GATEWAY_PROD_URL : GATEWAY_LOCAL_URL;

  const test = async () => {
    if (!testKey.trim()) { setTestMsg('Paste a router API key first (create one in API Keys).'); return; }
    setTesting(true);
    setTestMsg('');
    try {
      const models = await testGatewayConnection(baseUrl, testKey.trim());
      setTestMsg(`✓ Connected. The gateway lists ${models.length} model(s): ${models.slice(0, 8).join(', ')}${models.length > 8 ? '…' : ''}`);
    } catch (e) {
      setTestMsg(`✗ ${e instanceof Error ? e.message : 'Connection failed.'}`);
    } finally {
      setTesting(false);
    }
  };

  const configExample = (): string => {
    switch (client) {
      case 'opencode':
        return opencodeJson(baseUrl, useRouter);
      case 'claude-code':
        return [
          '# Claude Code — point it at the router\'s Anthropic-compatible endpoint',
          `export ANTHROPIC_BASE_URL="${baseUrl}"`,
          'export ANTHROPIC_API_KEY="<your-router-api-key>"   # router key, not an Anthropic key',
          `export ANTHROPIC_MODEL="coordinator"               # router alias = multi-model chain`,
          '',
          '# Then run:  claude',
          '# The router translates Anthropic messages to the chain\'s first available model.',
        ].join('\n');
      case 'vscode':
        return JSON.stringify({
          models: [
            { title: 'Router — Coordinator', provider: 'Jhinuk AI Router', model: 'coordinator', apiKey: '<your-router-api-key>', apiBase: baseUrl },
            { title: 'Router — Coder', provider: 'Jhinuk AI Router', model: 'coder', apiKey: '<your-router-api-key>', apiBase: baseUrl },
          ],
        }, null, 2);
      case 'aider':
        return [
          '# Aider — OpenAI-compatible via env vars',
          `export OPENAI_API_BASE="${baseUrl}"`,
          'export OPENAI_API_KEY="<your-router-api-key>"',
          '',
          '# Run with a router alias as the model:',
          '#   aider --model coordinator',
          '#   aider --model coder',
        ].join('\n');
      default:
        return [
          '# Generic OpenAI-compatible client',
          `BASE_URL="${baseUrl}"`,
          'API_KEY="<your-router-api-key>"',
          '',
          '# curl example:',
          `curl ${baseUrl}/chat/completions \\`,
          '  -H "Content-Type: application/json" \\',
          '  -H "Authorization: Bearer <your-router-api-key>" \\',
          '  -d \'{"model": "coordinator", "messages": [{"role": "user", "content": "Hello"}]}\'',
          '',
          '# List available models (aliases included):',
          `curl ${baseUrl}/models -H "Authorization: Bearer <your-router-api-key>"`,
        ].join('\n');
    }
  };

  return (
    <Layout title="Client Setup">
      <Card>
        <CardHeader title="Connect a client" sub="Pick your client, pick production or local dev, copy the config. Your API key is never displayed here — create one in API Keys and paste it into your client." />
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Client">
              <Select value={client} onChange={(e) => setClient(e.target.value as ClientId)}>
                {CLIENTS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </Select>
            </Field>
            <Field label="Environment">
              <Select value={env} onChange={(e) => setEnv(e.target.value as 'prod' | 'local')}>
                <option value="prod">Production — router.developersbd.top</option>
                <option value="local">Local dev — localhost:3001</option>
              </Select>
            </Field>
            {client === 'opencode' && (
              <Field label="OpenCode mode">
                <Select value={useRouter ? 'router' : 'direct'} onChange={(e) => setUseRouter(e.target.value === 'router')}>
                  <option value="router">Via router aliases (recommended)</option>
                  <option value="direct">Direct provider lists (no router)</option>
                </Select>
              </Field>
            )}
          </div>
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{CLIENTS.find((c) => c.id === client)?.desc}</p>

          <div className="mt-4 space-y-2 text-sm">
            <p><b>Base URL:</b> <code className="rounded bg-slate-100 px-1 font-mono text-xs dark:bg-slate-800">{baseUrl}</code></p>
            <p><b>API key:</b> create one in <a href="#/api-keys" className="text-indigo-600">API Keys</a>, copy it once, and paste it into your client config. It is shown only at creation and never again — not here, not in logs.</p>
            <p><b>Model / alias:</b> use a router alias (<code className="font-mono text-xs">coordinator</code>, <code className="font-mono text-xs">fast</code>, <code className="font-mono text-xs">coder</code>, <code className="font-mono text-xs">developer</code>, <code className="font-mono text-xs">reasoner</code>, <code className="font-mono text-xs">architect</code>) or a concrete <code className="font-mono text-xs">provider/model</code> id. Aliases resolve to the multi-model chain you edit in Routing Profiles.</p>
          </div>

          <div className="mt-4"><CodeBlock label="Configuration" code={configExample()} /></div>

          <div className="mt-4 flex flex-wrap items-end gap-2">
            <Field label="Test connection — paste a router API key">
              <TextInput type="password" value={testKey} onChange={(e) => setTestKey(e.target.value)} placeholder="rk-…" autoComplete="off" />
            </Field>
            <Button onClick={() => void test()} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</Button>
          </div>
          {testMsg && <div className="mt-2"><Alert kind={testMsg.startsWith('✓') ? 'success' : 'error'}>{testMsg}</Alert></div>}
          <p className="mt-2 text-xs text-slate-500">The test key is used for this one request only and is never stored.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Per-agent mapping — OpenCode agents → router aliases" sub="Each alias IS the multi-model chain. Edit the chain once in Routing Profiles; all agents pick it up. Default chains shown (live chains may differ — Routing Profiles is the source of truth)." />
        <Table headers={['OpenCode agent', 'Router alias (model id)', 'Fallback chain']}>
          {ROUTER_ALIASES.map((a) => (
            <tr key={a.alias} className="border-b border-slate-100 dark:border-slate-800">
              <Td>{a.agent}</Td>
              <Td><code className="rounded bg-slate-100 px-1 font-mono text-xs dark:bg-slate-800">{a.alias}</code></Td>
              <Td>{chainLabel(a.chain, seedDisplayName)}</Td>
            </tr>
          ))}
        </Table>
        <CardBody>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            <b>How it works:</b> OpenCode sends <code className="font-mono text-xs">model: "router/coordinator"</code> to the router.
            The router runs the Coordinator chain — Luna first, then DeepSeek Flash, then Kimi — falling back only on 429 / 5xx / timeout / unavailable.
            Change the order in Routing Profiles and the next OpenCode request uses the new order; no opencode.json edit needed.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="RTK coexistence — read this before changing anything" sub="Your local RTK OpenCode plugin keeps working with the router. Do not add a second proxy." />
        <CardBody>
          <ul className="list-disc space-y-2 pl-5 text-sm">
            <li><b>Keep the RTK plugin as-is</b> on your PC (<code className="font-mono text-xs">C:\Users\Jhinuk\.config\opencode\plugins\rtk.ts</code>). Set the router as the base URL in opencode.json — RTK hooks run in OpenCode, the router is just the endpoint. Nothing in RTK needs to change.</li>
            <li><b>Do NOT put a proxy between OpenCode and the router</b> (RTK's proxy daemon was declined for a reason). RTK + router must not both proxy the same request: the router does RTK-style saving <i>inside</i> the gateway — safe prompt/context compression, noisy tool-output trimming, prompt caching where the provider supports it, duplicate-request prevention (idempotency), context-budget validation.</li>
            <li><b>Per-request toggle:</b> send <code className="font-mono text-xs">rtk: true</code> (default ON for noisy output) or <code className="font-mono text-xs">rtk: false</code> to disable gateway-side optimisation for a single request.</li>
            <li><b>Tokens saved are recorded</b> per request (UsageRecord.tokensSaved) and shown on the Usage / Hiseb page — that is how you verify the saving is real.</li>
            <li>If you ever see double counting or double trimming, turn RTK's trimming off in the plugin <i>or</i> set <code className="font-mono text-xs">rtk: false</code> on the request — never run both trims on the same text.</li>
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Direct opencode.json — for non-router users" sub="Same agents, but with concrete provider/model lists instead of router aliases. Use this if you are NOT pointing OpenCode at the router." />
        <CardBody><CodeBlock label="opencode.json (direct, no router)" code={opencodeJson(baseUrl, false)} /></CardBody>
      </Card>
    </Layout>
  );
}
