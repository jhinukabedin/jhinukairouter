import { useEffect, useState } from 'react';
import { api, normalizePaged, type CreditTransaction, type CreditWallet } from '../lib/api';
import { Layout } from '../components/Layout';
import { Card, CardBody, CardHeader, Stat } from '../components/Card';
import { Table, Td } from '../components/Table';
import { Alert, ApiDownNote, Button, EmptyState, Field, Spinner, TextInput } from '../components/forms';

export default function Credits() {
  const [wallet, setWallet] = useState<CreditWallet | null>(null);
  const [txs, setTxs] = useState<CreditTransaction[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [adjustUser, setAdjustUser] = useState('');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustNote, setAdjustNote] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [w, t] = await Promise.all([api.wallet(), api.transactions({ page: '1', limit: '50' })]);
      setWallet(w);
      setTxs(normalizePaged<CreditTransaction>(t).data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load credits.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const adjust = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg('');
    try {
      await api.adjustCredits({ userId: adjustUser, amount: Number(adjustAmount), description: adjustNote || undefined });
      setMsg('Adjustment recorded (admin only).');
      setAdjustAmount('');
      setAdjustNote('');
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Adjustment failed.');
    }
  };

  if (loading) return <Layout title="Credits"><Spinner /></Layout>;
  return (
    <Layout title="Credits">
      {error && <ApiDownNote error={error} />}
      {msg && <Alert kind="info">{msg}</Alert>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Wallet balance" value={wallet ? `${Number(wallet.balance).toFixed(2)} ${wallet.currency}` : '—'} sub="Your credit wallet" />
        <Stat label="Transactions shown" value={String(txs.length)} sub="Latest 50" />
        <Stat label="Total credited" value={txs.filter((t) => t.amount > 0).reduce((s, t) => s + Number(t.amount), 0).toFixed(2)} sub="In this list" />
      </div>
      <Card>
        <CardHeader title="Transactions" sub="Immutable ledger — purchases, debits, refunds, adjustments. All from the credits API." />
        {txs.length === 0 ? (
          <CardBody><EmptyState>No credit transactions yet.</EmptyState></CardBody>
        ) : (
          <Table headers={['Date', 'Type', 'Amount', 'Description', 'Request']}>
            {txs.map((t) => (
              <tr key={t.id} className="border-b border-slate-100 dark:border-slate-800">
                <Td className="whitespace-nowrap">{new Date(t.createdAt).toLocaleString()}</Td>
                <Td>{t.type}</Td>
                <Td className={Number(t.amount) < 0 ? 'text-red-600' : 'text-emerald-600'}>{Number(t.amount).toFixed(2)}</Td>
                <Td>{t.description ?? '—'}</Td>
                <Td className="font-mono text-xs">{t.requestId ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title="Admin: adjust credits" sub="Admin only — the API rejects this for non-admins. Amount can be negative (debit) or positive (credit)." />
        <CardBody>
          <form onSubmit={adjust} className="flex flex-wrap items-end gap-3">
            <Field label="User ID"><TextInput required value={adjustUser} onChange={(e) => setAdjustUser(e.target.value)} placeholder="user UUID" /></Field>
            <Field label="Amount"><TextInput required type="number" step="0.01" value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} placeholder="+100 / -25" /></Field>
            <Field label="Note"><TextInput value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder="Reason" /></Field>
            <Button type="submit">Record adjustment</Button>
          </form>
        </CardBody>
      </Card>
    </Layout>
  );
}
