import { ArrowUpRight, CircleDot, Cloud, Compass, UserRound, Users, X } from 'lucide-react';
import { StatusMessage } from './components/status-message.tsx';
import { Badge } from './components/ui/badge.tsx';
import { Card } from './components/ui/card.tsx';
import { Dialog, DialogContent, DialogClose, DialogTitle } from './components/ui/dialog.tsx';
import { Button } from './components/ui/button.tsx';
import { Input } from './components/ui/input.tsx';
import { Field, FieldDescription, FieldGroup, FieldLabel } from './components/ui/field.tsx';
import { EmptyState } from './components/empty-state.tsx';
import React, { lazy, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, API_URL, type ServiceStatus } from './api.ts';
import {useAccountSession,accountAction,accountsConfigured,cloudAccountsEnabled,cloudAccountRequest,signOutAccount} from './account-session.ts';
import type { AdventureSummary, GameVersion, PublicProfile } from '../../../packages/protocol/index.ts';
import { ScreenLoader } from './components/screen-loader.tsx';
import type {BattleView, LiveBattle, WatchSide} from '../../../packages/battles/protocol.ts';
import type { TradeSceneBootstrap } from '../../server/src/trade-scenes.ts';
import type { SessionBootstrap } from '../../server/src/sessions.ts';
import './theme.css';
import './style.css';

const Game = lazy(() => import('./game.tsx').then(module => ({ default: module.Game })));
const Lobby = lazy(() => import('./lobby.tsx').then(module => ({ default: module.Lobby })));
const Battle = lazy(() => import('./battle.tsx').then(module => ({ default: module.Battle })));
const Watch = lazy(() => import('./watch.tsx').then(module => ({ default: module.Watch })));

const versions = [
  { id: 'firered' as const, name: 'FireRed', subtitle: 'A spark of adventure.', number: '01', label: 'FIRE', color: 'red' },
  { id: 'leafgreen' as const, name: 'LeafGreen', subtitle: 'A fresh path to discover.', number: '02', label: 'LEAF', color: 'green' },
];

function Ball({ decorative = false }: { decorative?: boolean }) {
  return <span className="ball" aria-hidden={decorative || undefined}><span /></span>;
}

function App() {
  const {session,recovery,refresh}=useAccountSession();
  const currentOwner=useRef(session?.user.id);currentOwner.current=session?.user.id;
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [adventures, setAdventures] = useState<AdventureSummary[]>([]);
  const [status, setStatus] = useState<ServiceStatus>();
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<'adventure'|'lobby'|'profile'>('adventure');
  const [authView, setAuthView] = useState<'login'|'signup'|'reset'|'recovery'|null>(null);
  const [playing, setPlaying] = useState<GameVersion>();
  const [playingAdventure,setPlayingAdventure]=useState<string>();
  const [battle,setBattle]=useState<BattleView>();
  const [watching,setWatching]=useState<{battle:LiveBattle;side:WatchSide}>();
  const [resumeBootstrap, setResumeBootstrap] = useState<SessionBootstrap | TradeSceneBootstrap>();
  const [busy, setBusy] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_URL}/api/status`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('The game service is unavailable.');
      setStatus(await response.json());
    }).catch(error => { if (error.name !== 'AbortError') setConnectionError('The game service is offline. Start the local API to connect.'); });
    return () => controller.abort();
  }, []);

  useEffect(()=>{if(recovery)setAuthView('recovery');else if(session)setAuthView(null);},[recovery,session?.user.id]);

  useEffect(() => {
    let current = true;
    // A different account must not inherit the previous trainer's visible state.
    setProfile(null); setAdventures([]); setOnboarding(false); setPlaying(undefined);setPlayingAdventure(undefined); setBattle(undefined); setWatching(undefined); setResumeBootstrap(undefined);
    if (!session) return;
    void api<{ profile: PublicProfile | null }>('/api/profile').then(result => {
      if (!current) return;
      setProfile(result.profile); setOnboarding(!result.profile&&!recovery);
    }).catch(error => { if (current) setNotice(error.message); });
    return () => { current = false; };
  }, [session?.user.id,recovery]);

  useEffect(() => {
    // Returning from play or the lobby can change either save. Refresh from the
    // server, and discard responses after navigation or an account change.
    if (!profile || profile.id !== session?.user.id || playing || battle || view !== 'adventure') return;
    let current = true;
    void api<{ adventures: AdventureSummary[] }>('/api/adventures').then(result => {
      if (current) setAdventures(result.adventures);
    }).catch(error => { if (current) setNotice(error.message); });
    return () => { current = false; };
  }, [profile?.id, session?.user.id, playing, battle, view]);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setNotice('');
    try {
      if (!accountsConfigured()) throw new Error('Account services need configuration before sign-in is available.');
      const form = new FormData(event.currentTarget);
      const email = String(form.get('email') ?? ''),password = String(form.get('password') ?? '');
      const action=authView??'login';await accountAction(action,email,password);
      if(action==='signup')setNotice('Check your email to confirm your account, then choose your trainer name.');
      else if(action==='reset')setNotice('If an account uses that address, a password reset email is on its way.');
      else if(action==='recovery'){setNotice('Your password has been updated.');history.replaceState({},'', '/');await refresh();}
      else await refresh();
      setAuthView(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  }

  async function chooseHandle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setNotice('');
    try {
      const handle = String(new FormData(event.currentTarget).get('handle'));
      const owner=session?.user.id;
      if(cloudAccountsEnabled)await cloudAccountRequest('profile',{handle});
      const result = cloudAccountsEnabled?await api<{profile:PublicProfile}>('/api/profile'):await api<{ profile: PublicProfile }>('/api/profile', { handle });
      if(currentOwner.current===owner){setProfile(result.profile); setOnboarding(false);}
    } catch (error) { setNotice(error instanceof Error ? error.message : 'The name could not be reserved.'); }
    finally { setBusy(false); }
  }

  async function createAdventure(version:GameVersion){
    const owner=session?.user.id;if(!owner||!cloudAccountsEnabled)return;
    setBusy(true);setNotice('');
    try{await cloudAccountRequest('adventures',{version});const value=await api<{adventures:AdventureSummary[]}>('/api/adventures');if(currentOwner.current===owner)setAdventures(value.adventures);}
    catch(error){if(currentOwner.current===owner)setNotice(error instanceof Error?error.message:'The adventure could not be created.');}
    finally{setBusy(false);}
  }

  if(watching)return <ScreenLoader key={`watch-${watching.battle.id}`} name="Live battle"><Watch battle={watching.battle} side={watching.side} onExit={()=>{setWatching(undefined);setView('lobby');}}/></ScreenLoader>;
  if(battle)return <ScreenLoader key="battle" name="Battle"><Battle battle={battle} onExit={()=>{setBattle(undefined);setView('lobby');}}/></ScreenLoader>;

  function launch(version: GameVersion,adventureId?:string) {
    if (!session) { setAuthView('login'); return; }
    if (!profile) { setOnboarding(true); return; }
    setResumeBootstrap(undefined);
    setPlayingAdventure(adventureId);
    setPlaying(version);
  }

  if (playing) return <ScreenLoader key="game" name="Adventure"><Game version={playing} adventureId={playingAdventure} initialBootstrap={resumeBootstrap} onExit={() => {
    setView(resumeBootstrap && 'mode' in resumeBootstrap?'lobby':'adventure');
    setPlaying(undefined);setPlayingAdventure(undefined); setResumeBootstrap(undefined);
  }} onLobby={status?.multiplayer.lobby && !(resumeBootstrap && 'mode' in resumeBootstrap) ? () => { setPlaying(undefined);setPlayingAdventure(undefined); setResumeBootstrap(undefined); setView('lobby'); } : undefined} /></ScreenLoader>;

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Kanto Online home"><Ball decorative /><span>KANTO<span className="brand-light">ONLINE</span></span></a>
      <Badge variant="outline" className="build-badge">DEVELOPMENT BUILD</Badge>
      <div className="account-actions">{session ? <><Badge variant="secondary" className="trainer-pill"><UserRound aria-hidden="true" />{profile?.handle ?? 'New trainer'}</Badge><Button variant="ghost" disabled={busy} onClick={()=>{setBusy(true);void signOutAccount().then(()=>refresh()).catch(error=>setNotice(error.message)).finally(()=>setBusy(false));}}>Sign out</Button></>
        : <><Button variant="ghost" onClick={() => setAuthView('login')}>Log in</Button><Button size="sm" onClick={() => setAuthView('signup')}>Create account <ArrowUpRight aria-hidden="true" /></Button></>}</div>
    </header>
    <div className="workspace">
      <aside className="sidebar"><p className="eyebrow">YOUR JOURNEY</p><nav aria-label="Main navigation">
        <Button variant="ghost" className="nav-item" aria-current={view === 'adventure' ? 'page' : undefined} onClick={() => setView('adventure')}><Compass aria-hidden="true" />Adventures</Button>
        <Button variant="ghost" className="nav-item" aria-current={view === 'lobby' ? 'page' : undefined} onClick={() => setView('lobby')}><Users aria-hidden="true" />Online lobby</Button>
        <Button variant="ghost" className="nav-item" aria-current={view === 'profile' ? 'page' : undefined} onClick={() => setView('profile')}><UserRound aria-hidden="true" />Trainer profile</Button>
      </nav><div className="sidebar-note"><span className="tiny-ball">●</span><h3>A familiar world.<br />A new connection.</h3><p>Your adventure, with a place to meet other trainers.</p></div><div className="service-status"><i className={status ? 'status-dot connected' : 'status-dot'} /><span>{status ? 'Service connected' : 'Service disconnected'}</span></div></aside>
      <main>
        {notice && !authView && !onboarding && <StatusMessage className="notice"><span>{notice}</span><Button variant="ghost" size="icon-sm" onClick={() => setNotice('')} aria-label="Dismiss message"><X aria-hidden="true" /></Button></StatusMessage>}
        {view === 'adventure' && <>
          <div className="section-kicker"><span>PALLET TOWN → EVERYWHERE</span><span>YOUR ADVENTURE AWAITS</span></div>
          <section className="hero"><div><p className="eyebrow accent">BACK TO WHERE IT ALL BEGAN</p><h1>A whole world.<br /><span>One first step.</span></h1><p className="hero-description">Catch your first partner. Take the long way through Kanto.<br className="desktop-break" /> Make this adventure your own.</p></div><div className="hero-mark" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="large-ball"><span /></div><span className="spark spark-one">✦</span><span className="spark spark-two">+</span><span className="coordinates">35°30′ N<br />139°41′ E</span></div></section>
          <div className="section-heading"><h2>Choose your adventure</h2><span>Two versions. Your own story.</span></div>
          <div className="version-grid">{versions.flatMap(version => {
            const engine = status?.engines.find(item => item.version === version.id);
            const owned=adventures.filter(item=>item.version===version.id);
            return (owned.length?owned:[undefined]).map(adventure=>{
            const slot=(adventure?.slot??0)+1,title=version.name+(slot>1?` ${slot}`:'');
            return <Card className={`version-card ${version.color} gap-0 py-0`} key={adventure?.id??version.id}>
              <div className="card-art" aria-hidden="true"><span className="card-index">KANTO EDITION / {version.number}</span><span className="art-word">{version.label}</span><svg className="element-symbol" viewBox="0 0 120 140">{version.id === 'firered'
                ? <path d="M65 5c12 35-20 42-9 67 15-5 19-21 15-30 43 33 50 74 18 91-26 14-70 4-73-27-3-24 17-36 21-56 13 10 17 20 15 30C75 58 44 36 65 5Z" />
                : <><path d="M106 8C52 8 2 32 13 82c8 38 67 49 87 5 12-26-5-48 6-79Z" /><path className="leaf-vein" d="M21 125 83 35M43 95 41 65M60 74l25-2" /></>}</svg><div className="card-art-bottom"><span>POKÉMON</span><span>GENERATION III</span></div></div>
              <div className="card-body"><div className="card-title"><h3>{title}</h3><span className="version-dot" /></div><p>{version.subtitle}</p>
                <div className="save-line"><span>{adventure?.hasSave ? <Cloud aria-hidden="true" /> : <CircleDot aria-hidden="true" />}{adventure?.hasSave ? 'Cloud save' : 'A new beginning'}</span><span>{adventure?`Adventure ${slot}`:'Choose your edition'}</span></div>
                <Button variant="secondary" size="lg" className="version-button" disabled={busy||!engine?.available} onClick={() => launch(version.id,adventure?.id)}>{engine?.available ? adventure?.hasSave ? 'Continue adventure' : 'Begin adventure' : 'Game port in development'}<ArrowUpRight aria-hidden="true" /></Button>
              </div></Card>;
          });})}</div>
          {cloudAccountsEnabled&&profile&&<><div className="adventure-actions">{versions.map(version=><Button key={version.id} variant="outline" size="lg" disabled={busy||adventures.filter(v=>v.version===version.id).length>=3} onClick={()=>void createAdventure(version.id)}>New {version.name} adventure</Button>)}</div><p className="adventure-note">Online adventures have separate progress during this preview. Your solo cloud saves stay available in the browser player.</p></>}
          <div className="feature-strip"><div><span>01</span><p><strong>Make it yours</strong>A unique name. Your adventures.</p></div><div><span>02</span><p><strong>Pick up where you left off</strong>Verified progress saved online.</p></div><div><span>03</span><p><strong>Meet your next rival</strong>Global battles and trades.</p></div></div>
          <StatusMessage className="development-note"><p><strong>The journey is being built.</strong> The game port, cloud saves, and multiplayer are under development. Play opens when the actual game runtime is ready.{connectionError && ` ${connectionError}`}</p></StatusMessage>
        </>}
        {view === 'lobby' && <ScreenLoader key="lobby" name="Online lobby"><Lobby authenticated={Boolean(profile && session)} available={Boolean(status?.multiplayer.lobby)} trading={Boolean(status?.multiplayer.trading)} battles={Boolean(status?.multiplayer.battles)} onBattle={setBattle}
          onWatch={(battle,side)=>setWatching({battle,side})}
          onAdventures={() => setView('adventure')} onResume={bootstrap => { setResumeBootstrap(bootstrap);setPlayingAdventure(bootstrap.adventureId); setPlaying(bootstrap.manifest.version); }} /></ScreenLoader>}
        {view === 'profile' && <section className="empty-view"><p className="eyebrow accent">YOUR TRAINER CARD</p><h1>{profile?.handle ?? 'Your story starts here.'}</h1><p>{profile ? 'One trainer. All your Kanto adventures.' : 'Create an account and reserve a unique trainer name.'}</p><EmptyState icon={UserRound} className="profile-empty" title={profile ? `@${profile.handle}` : 'A name of your own'} action={!profile && <Button size="lg" onClick={() => session ? setOnboarding(true) : setAuthView('signup')}>{session ? 'Choose trainer name' : 'Create account'} <ArrowUpRight aria-hidden="true" /></Button>}>{profile ? 'Your public handle is reserved. Your adventures stay linked to this account.' : 'Your trainer name will identify you in battles and trades.'}</EmptyState></section>}
        <footer><span>KANTO ONLINE</span><span>A new home for a familiar adventure.</span><span>DEVELOPMENT / 0.1</span></footer>
      </main>
    </div>
    <Dialog open={Boolean(authView || onboarding)} onOpenChange={open => { if (!open) { setAuthView(null); setOnboarding(false); } }}><DialogContent className="modal" showCloseButton={false}
      onOpenAutoFocus={() => { dialogReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={event => { if (dialogReturnFocus.current?.isConnected) { event.preventDefault(); dialogReturnFocus.current.focus(); } }} aria-labelledby="dialog-title" aria-describedby={undefined}><DialogClose asChild><Button variant="ghost" size="icon-sm" className="modal-close" aria-label="Close dialog" onClick={() => { setAuthView(null); setOnboarding(false); }}><X aria-hidden="true" /></Button></DialogClose><Ball decorative />
      {onboarding ? <><p className="eyebrow accent">WELCOME, TRAINER</p><DialogTitle id="dialog-title">What should we call you?</DialogTitle><p>Your unique public name for battles and trades. Choose carefully: it stays with your account.</p><form onSubmit={chooseHandle}><Field><FieldLabel htmlFor="account-handle">Trainer name</FieldLabel><Input id="account-handle" name="handle" autoFocus required minLength={3} maxLength={16} pattern="[A-Za-z][A-Za-z0-9_]{2,15}" autoComplete="nickname" placeholder="Your trainer name" aria-describedby="handle-description" /><FieldDescription id="handle-description">3–16 letters, numbers or underscores. Start with a letter.</FieldDescription></Field><Button size="lg" disabled={busy} aria-busy={busy}>{busy ? 'Reserving…' : 'Reserve name'}<ArrowUpRight aria-hidden="true" /></Button></form></>
        : <><p className="eyebrow accent">YOUR NEXT CHAPTER</p><DialogTitle id="dialog-title">{authView === 'signup' ? 'A new adventure starts here.' : authView === 'reset' ? 'Get back on your journey.' : authView === 'recovery' ? 'Choose a new password.' : 'Welcome back, trainer.'}</DialogTitle><p>{authView === 'signup' ? 'Create your account, verify your email, and choose a unique trainer name.' : authView === 'reset' ? 'We’ll send a link to reset your password.' : 'Your adventures will be right where you left them.'}</p>
          {!accountsConfigured() && <StatusMessage>Account services need configuration before sign-in is available.</StatusMessage>}
          <form onSubmit={authenticate}><FieldGroup>{authView !== 'recovery' && <Field><FieldLabel htmlFor="account-email">Email address</FieldLabel><Input id="account-email" type="email" name="email" required autoComplete="email" placeholder="you@example.com" /></Field>}{authView !== 'reset' && <Field><FieldLabel htmlFor="account-password">{authView === 'recovery' ? 'New password' : 'Password'}</FieldLabel><Input id="account-password" type="password" name="password" required minLength={authView === 'login' ? 1 : 12} autoComplete={authView === 'login' ? 'current-password' : 'new-password'} aria-describedby={authView === 'signup' || authView === 'recovery' ? 'password-description' : undefined} />{(authView === 'signup' || authView === 'recovery') && <FieldDescription id="password-description">Use at least 12 characters.</FieldDescription>}</Field>}</FieldGroup>
          <Button size="lg" disabled={busy || !accountsConfigured()} aria-busy={busy}>{busy ? 'Please wait…' : authView === 'signup' ? 'Create account' : authView === 'reset' ? 'Send reset link' : authView === 'recovery' ? 'Update password' : 'Log in'}<ArrowUpRight aria-hidden="true" /></Button></form>
          <div className="auth-links">{authView === 'login' ? <><Button variant="link" size="sm" onClick={() => setAuthView('reset')}>Forgot password?</Button><Button variant="link" size="sm" onClick={() => setAuthView('signup')}>Create account</Button></> : <Button variant="link" size="sm" onClick={() => setAuthView('login')}>Back to log in</Button>}</div></>}
      {notice && (authView||onboarding) && <StatusMessage destructive>{notice}</StatusMessage>}
    </DialogContent></Dialog>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
