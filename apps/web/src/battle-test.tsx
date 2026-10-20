import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Battle } from './battle.tsx';
import { accountCredentials } from './account-session.ts';
import type { BattleView } from '../../../packages/battles/protocol.ts';
import './battle-test.css';

type Opponent = { id: string; handle: string; version: string };
type Profile = { id: string; handle: string } | null;
const credentialExpiry = () => Date.now() + 3_600_000;

async function request<T>(path: string, token?: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = text; }
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'message' in value ? String((value as { message: unknown }).message) : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return value as T;
}

function message(error: unknown) { return error instanceof Error ? error.message : 'The request failed.'; }

function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [handle, setHandle] = useState('');
  const [token, setToken] = useState('');
  const [owner, setOwner] = useState('');
  const [profile, setProfile] = useState<Profile>(null);
  const [opponents, setOpponents] = useState<Opponent[]>([]);
  const [battles, setBattles] = useState<BattleView[]>([]);
  const [battle, setBattle] = useState<BattleView>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(body: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await body(); } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function signIn(create = false) {
    await run(async () => {
      const result = await request<{ token: string; user: { id: string; email: string } }>(
        `/api/cloud/auth/${create ? 'sign-up' : 'sign-in'}/email`, undefined,
        create ? { name: 'Battle test', email, password, callbackURL: location.origin } : { email, password });
      if (create) { setNotice('Check your email to confirm the account, then sign in.'); return; }
      accountCredentials.observe({ owner: result.user.id, token: result.token, emailVerified: true, expiresAt: credentialExpiry() });
      setToken(result.token); setOwner(result.user.id);
      const current = await request<{ profile: Profile }>('/api/cloud/profile', result.token);
      setProfile(current.profile);
      setNotice(current.profile ? 'Signed in.' : 'Choose a trainer name to continue.');
    });
  }

  async function reserve() {
    await run(async () => {
      await request('/api/cloud/profile', token, { handle });
      const current = await request<{ profile: Profile }>('/api/cloud/profile', token);
      setProfile(current.profile);
      setNotice('Trainer name reserved.');
    });
  }

  async function prepare() {
    await run(async () => {
      const result = await request<{ handle: string }>('/api/online/test-lobby', token, {});
      setNotice(`Test lobby ready for @${result.handle}.`);
      setHandle(result.handle);
      await refresh();
    });
  }

  async function refresh() {
    if (!token) return;
    const [directory, list] = await Promise.all([
      request<{ opponents: Opponent[] }>('/api/online/test-lobby', token),
      request<{ battles: BattleView[] }>('/api/online/battles', token)
    ]);
    setOpponents(directory.opponents);
    setBattles(list.battles.filter(value => ['offered', 'starting', 'active'].includes(value.status)));
  }

  async function challenge(opponent: Opponent) {
    await run(async () => {
      await request<BattleView>('/api/online/battles', token, { trainerId: opponent.id });
      setNotice(`Challenge sent to @${opponent.handle}.`);
      await refresh();
    });
  }

  async function accept(value: BattleView) {
    await run(async () => {
      const result = await request<{ battle: BattleView }>(`/api/online/battles/${value.id}/accept`, token, {});
      setBattle(result.battle); setNotice('Battle accepted.');
    });
  }

  useEffect(() => {
    if (!token) return;
    let current = true;
    const timer = setInterval(() => { if (current && !battle) void refresh().catch(() => undefined); }, 3000);
    return () => { current = false; clearInterval(timer); };
  }, [token, battle]);

  if (battle) return <Battle battle={battle} onExit={() => { setBattle(undefined); void refresh().catch(() => undefined); }} />;

  return <main className="app-shell" style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
    <p className="eyebrow accent">PRIVATE NETLIFY BATTLE TEST</p>
    <h1>Two-account HTTP battle test</h1>
    <p>This page is available only on the private branch preview. It uses the same account and original-C battle Functions as the hosted API test.</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="game-error">{error}</p>}
    {!token ? <section className="lobby-panel" style={{ marginTop: 24 }}>
      <h2>Sign in</h2>
      <label>Email <input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" /></label>
      <label>Password <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" minLength={12} /></label>
      <div className="lobby-toolbar">
        <button type="button" disabled={busy} onClick={() => void signIn(false)}>Sign in</button>
        <button type="button" disabled={busy} onClick={() => void signIn(true)}>Create account</button>
      </div>
      <p>Accounts need a confirmed email. Use two different addresses for the two players.</p>
    </section> : <>
      <section className="lobby-panel" style={{ marginTop: 24 }}>
        <h2>@{profile?.handle ?? 'Choose a trainer name'}</h2>
        {!profile && <div className="lobby-toolbar">
          <input value={handle} onChange={event => setHandle(event.target.value)} placeholder="Trainer name" />
          <button type="button" disabled={busy || handle.length < 3} onClick={() => void reserve()}>Reserve name</button>
        </div>}
        {profile && <div className="lobby-toolbar">
          <button type="button" disabled={busy} onClick={() => void prepare()}>Prepare test lobby</button>
          <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh</button>
          <span>{owner}</span>
        </div>}
      </section>
      {profile && <section className="lobby-panel" style={{ marginTop: 16 }}>
        <h2>Opponents in the test lobby</h2>
        {opponents.length === 0 ? <p>No other prepared trainer yet. Sign in as the second account, reserve a name and prepare its test lobby.</p>
          : <ul className="lobby-list">{opponents.map(opponent => <li key={opponent.id}>
            <span><strong>@{opponent.handle}</strong> · {opponent.version}</span>
            <button type="button" disabled={busy} onClick={() => void challenge(opponent)}>Challenge</button>
          </li>)}</ul>}
      </section>}
      {profile && <section className="lobby-panel" style={{ marginTop: 16 }}>
        <h2>Your battles</h2>
        {battles.length === 0 ? <p>No open battle. Challenge a prepared opponent.</p>
          : <ul className="lobby-list">{battles.map(value => <li key={value.id}>
            <span><strong>{value.status}</strong> · {value.playerA.handle} vs {value.playerB.handle} · side {value.side}</span>
            {value.status === 'offered' && value.side === 'b' && <button type="button" disabled={busy} onClick={() => void accept(value)}>Accept</button>}
            {value.status !== 'offered' && <button type="button" disabled={busy} onClick={() => setBattle(value)}>Continue</button>}
          </li>)}</ul>}
      </section>}
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
