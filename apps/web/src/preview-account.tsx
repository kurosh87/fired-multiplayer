import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createAuthClient } from 'better-auth/react';
import { CloudDownload, CloudUpload, LogOut, UserRound } from 'lucide-react';
import { Button } from './components/ui/button.tsx';
import { Card } from './components/ui/card.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './components/ui/dialog.tsx';
import { Field, FieldDescription, FieldGroup, FieldLabel } from './components/ui/field.tsx';
import { Input } from './components/ui/input.tsx';
import { StatusMessage } from './components/status-message.tsx';
import type { GameVersion } from '../../../packages/protocol/index.ts';
import type { CloudSlot } from '../../server/src/preview-cloud.ts';

const client = createAuthClient({ basePath: '/api/cloud/auth' });
type Overview = { profile: { id: string; handle: string } | null; slots: CloudSlot[] };
type ExportedSave = { flash: ArrayBuffer; version: GameVersion; adventureId?: string; bootId: number };
const editionName = (version: GameVersion) => version === 'firered' ? 'FireRed' : 'LeafGreen';
const slotName = (slot: CloudSlot) => editionName(slot.version) + (slot.slot ? ` ${slot.slot + 1}` : '');
async function accountApi<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api/cloud/' + path, { credentials: 'same-origin', ...options });
  const result = await response.json(); if (!response.ok) throw new Error(result.message ?? 'The request could not be completed.'); return result;
}
async function exportFlash(owner: string): Promise<ExportedSave> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (data.requestId !== requestId) return;
      clearTimeout(timeout); window.removeEventListener('kanto-preview-flash-result', finish);
      if (data.error) reject(new Error(data.error)); else resolve(data);
    };
    const timeout = window.setTimeout(() => { window.removeEventListener('kanto-preview-flash-result', finish); reject(new Error('The game did not provide its save. Try again.')); }, 10000);
    window.addEventListener('kanto-preview-flash-result', finish);
    window.dispatchEvent(new CustomEvent('kanto-preview-export-flash', { detail: { requestId, owner } }));
  });
}

export function PreviewAccount() {
  const { data: session, isPending, refetch } = client.useSession();
  const [sessionChecked,setSessionChecked]=useState(!isPending);
  useEffect(()=>{if(!isPending)setSessionChecked(true);},[isPending]);
  const [open, setOpen] = useState(false), [view, setView] = useState<'login' | 'signup' | 'reset' | 'recovery'>('login');
  const [overview, setOverview] = useState<Overview>(), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [load, setLoad] = useState<CloudSlot>();
  const [pendingSave, setPendingSave] = useState<ExportedSave>();
  const [emailValue,setEmailValue]=useState(''),[passwordValue,setPasswordValue]=useState('');
  const owner = session?.user.id;
  const currentOwner = useRef(owner); currentOwner.current = owner;
  useEffect(() => {
    let current = true; setOverview(undefined); setLoad(undefined); setPendingSave(undefined); setError(''); setMessage('');
    window.dispatchEvent(new CustomEvent('kanto-preview-account-changed', { detail: { owner } }));
    if (owner) void accountApi<Overview>('profile').then(value => { if (current) setOverview(value); }).catch(failure => { if (current) setError(failure.message); });
    return () => { current = false; };
  }, [owner]);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (query.has('token') && location.pathname === '/account/recovery') { setView('recovery'); setOpen(true); }
    if (query.has('error')) { setError('The account link has expired or is invalid. Request a new link.'); setOpen(true); }
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const data = new FormData(event.currentTarget), email = String(data.get('email') ?? ''), password = String(data.get('password') ?? '');
    try {
      if (owner && view !== 'recovery' && !overview?.profile) {
        const value = await accountApi<Overview>('profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: data.get('handle') }) });
        if (currentOwner.current === owner) setOverview(value);
      } else {
        const result = view === 'signup' ? await client.signUp.email({ name: 'Trainer', email, password, callbackURL: location.origin })
          : view === 'reset' ? await client.requestPasswordReset({ email, redirectTo: location.origin + '/account/recovery' })
          : view === 'recovery' ? await client.resetPassword({ newPassword: password, token: new URLSearchParams(location.search).get('token') ?? '' })
          : await client.signIn.email({ email, password });
        if (result.error) throw new Error(result.error.message ?? 'Account request failed.');
        setPasswordValue('');
        if (view === 'signup') setMessage('Check your email to confirm your account, then log in and choose your trainer name.');
        else if (view === 'reset') setMessage('If that address has an account, a password reset email is on its way.');
        else if (view === 'recovery') { setMessage('Password updated. You can log in now.'); setView('login'); history.replaceState({}, '', '/'); await refetch(); }
        else await refetch();
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Account request failed.'); }
    finally { setBusy(false); }
  }
  async function saveTo(exported: ExportedSave, slot: CloudSlot, account: string) {
    if (currentOwner.current !== account || slot.version !== exported.version) throw new Error('The account or edition changed.');
    const value = await accountApi<Overview>('adventures/' + slot.id + '/save', { method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Kanto-Revision': String(slot.revision) }, body: exported.flash });
    if (currentOwner.current === account) {
      setOverview(value); setPendingSave(undefined); setMessage('Game save synced. Your adventure stays paused; choose Resume when ready.');
      window.dispatchEvent(new CustomEvent('kanto-preview-bind-adventure', { detail: { owner: account, version: slot.version, adventureId: slot.id, bootId: exported.bootId } }));
    }
  }
  async function sync() {
    if (!owner || !overview) return; setBusy(true); setError(''); setMessage('');
    try {
      const exported = await exportFlash(owner);
      if (currentOwner.current !== owner) throw new Error('The signed-in account changed.');
      const slot = overview.slots.find(value => value.id === exported.adventureId && value.version === exported.version);
      if (slot) await saveTo(exported, slot, owner);
      else setPendingSave(exported);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The save could not sync.'); }
    finally { setBusy(false); }
  }
  async function restore(slot: CloudSlot) {
    if (!owner) return; setBusy(true); setError('');
    try {
      const { version } = slot;
      if (!slot.hasSave) {
        setLoad(undefined); setOpen(false);
        window.dispatchEvent(new CustomEvent('kanto-preview-load-save', { detail: { owner, version, adventureId: slot.id } }));
        return;
      }
      const response = await fetch('/api/cloud/adventures/' + slot.id + '/save', { credentials: 'same-origin' });
      if (!response.ok) throw new Error('The cloud save could not load.');
      const flash = await response.arrayBuffer(); if (flash.byteLength !== 131072) throw new Error('The cloud save has an invalid size.');
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', flash))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (digest !== response.headers.get('x-kanto-sha256')) throw new Error('The save failed its integrity check.');
      if (currentOwner.current !== owner) throw new Error('The signed-in account changed.');
      const revision = Number(response.headers.get('x-kanto-revision'));
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('The cloud save revision is invalid.');
      setOverview(current => current && ({ ...current, slots: current.slots.map(value => value.id === slot.id ? { ...value, revision, sha256: digest, hasSave: true } : value) }));
      setLoad(undefined); setOpen(false);
      window.dispatchEvent(new CustomEvent('kanto-preview-load-save', { detail: { owner, version, flash, adventureId: slot.id } }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The cloud save could not load.'); }
    finally { setBusy(false); }
  }
  async function createAdventure(version: GameVersion) {
    if (!owner) return; setBusy(true); setError('');
    try { const value = await accountApi<Overview>('adventures', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }) });
      if (currentOwner.current === owner) setOverview(value);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The adventure could not be created.'); }
    finally { setBusy(false); }
  }
  const title = load ? `${load.hasSave ? 'Load' : 'Start'} ${slotName(load)} adventure?` : pendingSave ? 'Choose an empty adventure slot' : view === 'recovery' ? 'Choose a new password' : overview?.profile ? `@${overview.profile.handle}`
    : owner ? 'Choose your trainer name' : view === 'signup' ? 'Start your account' : view === 'reset' ? 'Reset your password'
    : 'Welcome back, trainer';
  return <Dialog open={open} onOpenChange={value => { setOpen(value);if(!value)setPasswordValue(''); setLoad(undefined); setPendingSave(undefined); if (value) window.dispatchEvent(new Event('kanto-preview-pause')); }}>
    <DialogTrigger asChild><Button variant="ghost" className="tool" aria-label="Account and saves"><UserRound aria-hidden="true" /><span>{overview?.profile?.handle ?? 'Account'}</span></Button></DialogTrigger>
    <DialogContent className="preview-account-dialog"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>
      {load ? load.hasSave ? 'Your current unsynced progress will be replaced. The game opens at its title screen; choose CONTINUE.' : 'This starts a new game in this slot. Your current unsynced progress will be replaced.' : 'Keep up to three separate adventures in each edition.'}
    </DialogDescription></DialogHeader>
      {isPending&&!sessionChecked ? <p>Checking your account…</p> : load ? <div className="account-row"><Button variant="outline" disabled={busy} onClick={() => setLoad(undefined)}>Cancel</Button><Button disabled={busy} onClick={() => void restore(load)}><CloudDownload aria-hidden="true" />{load.hasSave ? 'Load cloud save' : 'Start adventure'}</Button></div>
        : overview?.profile && view !== 'recovery' ? <>
          <p>Use SAVE in the original game menu, then sync it here. Unsynced progress stays in this tab.</p>
          {pendingSave ? <>
            <p>Choose an empty {editionName(pendingSave.version)} slot. Existing cloud saves will be kept.</p>
            {overview.slots.filter(slot => slot.version === pendingSave.version && !slot.hasSave).map(slot => <Button key={slot.id} disabled={busy} onClick={() => {
              if (!owner) return; setBusy(true); setError(''); void saveTo(pendingSave,slot,owner).catch(failure => setError(failure.message)).finally(() => setBusy(false));
            }}>Save to {slotName(slot)}</Button>)}
            {!overview.slots.some(slot => slot.version === pendingSave.version && !slot.hasSave) && <StatusMessage>Create another adventure below, or load an existing save to continue it.</StatusMessage>}
            <Button variant="outline" disabled={busy} onClick={() => setPendingSave(undefined)}>Cancel sync</Button>
          </> : <Button disabled={busy} onClick={() => void sync()}><CloudUpload aria-hidden="true" />{busy ? 'Please wait…' : 'Sync current game save'}</Button>}
          {overview.slots.map(slot => <Card className="cloud-slot" key={slot.id}><strong>{slotName(slot)}</strong><span>{slot.hasSave ? 'Cloud save available' : 'No cloud save yet'}</span><Button variant="secondary" disabled={busy || Boolean(pendingSave)} onClick={() => setLoad(slot)}>{slot.hasSave ? 'Continue' : 'Start'} {slotName(slot)}</Button></Card>)}
          <div className="account-row">{(['firered','leafgreen'] as const).map(version => <Button key={version} variant="outline" disabled={busy || overview.slots.filter(slot => slot.version === version).length >= 3} onClick={() => void createAdventure(version)}>New {editionName(version)} adventure</Button>)}</div>
          <p className="account-caption">These preview saves are for solo play. Online battles and trades are under development.</p>
        </> : <form onSubmit={submit}><fieldset disabled={busy} className="contents"><FieldGroup>{owner && view !== 'recovery' ? <Field><FieldLabel htmlFor="preview-handle">Trainer name</FieldLabel><Input id="preview-handle" name="handle" required pattern="[A-Za-z][A-Za-z0-9_]{2,15}" minLength={3} maxLength={16} autoComplete="nickname" /><FieldDescription>3–16 letters, numbers or underscores. This name stays with your account.</FieldDescription></Field>
          : <>{view !== 'recovery' && <Field><FieldLabel htmlFor="preview-email">Email</FieldLabel><Input id="preview-email" name="email" type="email" required autoComplete="email" value={emailValue} onChange={event=>setEmailValue(event.target.value)} /></Field>}{view !== 'reset' && <Field><FieldLabel htmlFor="preview-password">Password</FieldLabel><Input id="preview-password" name="password" type="password" value={passwordValue} onChange={event=>setPasswordValue(event.target.value)} required minLength={view === 'login' ? 1 : 12} maxLength={128} autoComplete={view === 'login' ? 'current-password' : 'new-password'} /><FieldDescription>Use at least 12 characters for a new password.</FieldDescription></Field>}</>}
          <Button disabled={busy || Boolean(owner && view !== 'recovery' && !overview)}>{busy ? 'Please wait…' : view === 'recovery' ? 'Update password' : owner ? 'Reserve trainer name' : view === 'signup' ? 'Create account' : view === 'reset' ? 'Send reset link' : 'Log in'}</Button>
        </FieldGroup></fieldset></form>}
      {!owner && !load && <div className="account-row"><Button variant="link" disabled={busy} onClick={() => { setView(view === 'signup' ? 'login' : 'signup'); setError(''); setMessage(''); }}>{view === 'signup' ? 'Back to log in' : 'Create account'}</Button><Button variant="link" disabled={busy} onClick={() => { setView('reset'); setError(''); setMessage(''); }}>Forgot password?</Button></div>}
      {owner && !load && <div className="account-row">
        {!overview && <Button variant="outline" disabled={busy} onClick={() => { setBusy(true); void accountApi<Overview>('profile').then(value => { if (currentOwner.current === owner) { setOverview(value); setError(''); } }).catch(failure => setError(failure.message)).finally(() => setBusy(false)); }}>Retry account</Button>}
        <Button variant="ghost" disabled={busy} onClick={() => { setBusy(true); void client.signOut().then(async result => { if (result.error) throw new Error('Sign out failed.'); await refetch(); }).catch(() => setError('Sign out could not complete. Try again.')).finally(() => setBusy(false)); }}><LogOut aria-hidden="true" />Sign out</Button>
      </div>}
      {message && <StatusMessage>{message}</StatusMessage>}{error && <StatusMessage destructive>{error}</StatusMessage>}
    </DialogContent>
  </Dialog>;
}
