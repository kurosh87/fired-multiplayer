import { LobbyPanel } from './components/lobby-panel.tsx';
import { StatusMessage } from './components/status-message.tsx';
import { Button } from './components/ui/button.tsx';
import { Input } from './components/ui/input.tsx';
import { ArrowLeftRight, ChevronLeft, ChevronRight, RefreshCw, Search, Sparkles, Swords, UserRound, Users } from 'lucide-react';
import { EmptyState } from './components/empty-state.tsx';
import { Field, FieldLabel } from './components/ui/field.tsx';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.tsx';
import {useEffect,useRef,useState} from 'react';
import {api} from './api.ts';
import {directoryMessage,type DirectoryView,type LobbyPresenceMessage} from './lib/lobby-directory.ts';
import {openLobbyPresence} from './lib/lobby-presence.ts';
import type {LobbyTrainerPage} from '../../../packages/protocol/index.ts';
import type {LiveBattle} from '../../../packages/battles/protocol.ts';

/** Each page refreshes independently. A search/page change invalidates the
 * previous request, including a poll already in flight. */
export function TrainerDirectory({initialPage,disabled,trading,battles,myLevel,onTrade,onChallenge,onLive}:{
  initialPage:LobbyTrainerPage;disabled:boolean;trading:boolean;battles:boolean;myLevel:number;
  onTrade(id:string):void;onChallenge(id:string):void;onLive?(battles:LiveBattle[]):void;
}){
  const [page,setPage]=useState(initialPage),[draft,setDraft]=useState(''),[search,setSearch]=useState('');
  const [edition,setEdition]=useState(''),[near,setNear]=useState(false);
  const [cursors,setCursors]=useState(['']),[refreshToken,setRefreshToken]=useState(0);
  const [loading,setLoading]=useState(false),[error,setError]=useState('');
  const [live,setLive]=useState(false);
  const after=cursors.at(-1)!;
  const view=useRef<DirectoryView>({after,search,edition,near,myLevel});
  const liveHandler=useRef(onLive);
  useEffect(()=>{liveHandler.current=onLive;},[onLive]);
  useEffect(()=>{view.current={after,search,edition,near,myLevel};},[after,search,edition,near,myLevel]);
  // Live presence is additive: events shape the visible page, and the poll
  // above remains the authority for paging whenever the socket is absent.
  useEffect(()=>openLobbyPresence(
    (message:LobbyPresenceMessage)=>{
      if(message.type==='live'){liveHandler.current?.(message.battles);return;}
      setPage(current=>directoryMessage(current,message,view.current));
    },
    state=>setLive(state==='live')),[]);
  useEffect(()=>{
    let current=true,pending=false;
    if(disabled){setLoading(false);return;}
    const refresh=async()=>{
      if(pending||document.hidden)return;
      pending=true;setLoading(true);
      try{
        const query=new URLSearchParams();if(search)query.set('search',search);if(after)query.set('after',after);
        if(edition)query.set('version',edition);
        if(near&&myLevel>0){query.set('minLevel',String(Math.max(1,myLevel-10)));query.set('maxLevel',String(Math.min(100,myLevel+10)));}
        const result=await api<LobbyTrainerPage>(`/api/lobby/trainers${query.size?'?'+query:''}`);
        if(current){setPage(result);setError('');}
      }catch(failure){if(current)setError(failure instanceof Error?failure.message:'The trainer list could not refresh.');}
      finally{pending=false;if(current)setLoading(false);}
    };
    void refresh();const timer=setInterval(()=>void refresh(),20_000);
    const visible=()=>{if(!document.hidden)void refresh();};document.addEventListener('visibilitychange',visible);
    return()=>{current=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[after,search,edition,near,myLevel,refreshToken,disabled]);
  function reset(next:string){setLoading(true);setSearch(next);setCursors(['']);setRefreshToken(value=>value+1);}
  function refilter(update:()=>void){setLoading(true);update();setCursors(['']);setRefreshToken(value=>value+1);}
  return <LobbyPanel className="trainer-directory" title="Other trainers" icon={Users}
    description="Find your next rival or trading partner.">
    <form role="search" className="trainer-search" onSubmit={event=>{event.preventDefault();reset(draft.trim());}}>
      <Field className="trainer-search-field"><FieldLabel htmlFor="trainer-search">Find a trainer</FieldLabel><Input id="trainer-search" name="trainer" type="search" value={draft}
        onChange={event=>setDraft(event.target.value)} maxLength={16} pattern="[A-Za-z][A-Za-z0-9_]{0,15}"
        placeholder="Trainer name starts with…" autoComplete="off" disabled={disabled}/></Field>
      <Button variant="secondary" type="submit" disabled={disabled}><Search aria-hidden="true" />Search trainers</Button>
      {(draft||search)&&<Button variant="ghost" size="sm" type="button" disabled={disabled} onClick={()=>{setDraft('');reset('');}}>Clear search</Button>}
    </form>
    <div className="trainer-filters" role="group" aria-label="Trainer filters">
      <NativeSelect aria-label="Edition" value={edition} disabled={disabled}
        onChange={event=>{const value=event.target.value;refilter(()=>setEdition(value));}}>
        <NativeSelectOption value="">Either edition</NativeSelectOption>
        <NativeSelectOption value="firered">FireRed</NativeSelectOption>
        <NativeSelectOption value="leafgreen">LeafGreen</NativeSelectOption>
      </NativeSelect>
      <Button variant={near?'secondary':'outline'} size="sm" type="button" aria-pressed={near} disabled={disabled||myLevel<1}
        onClick={()=>refilter(()=>setNear(value=>!value))}><Sparkles aria-hidden="true" />Near my level</Button>
    </div>
    {error&&<StatusMessage destructive>{error}</StatusMessage>}
    <p className="trainer-page-status" role="status">{loading?'Finding trainers…':`Page ${cursors.length} · ${page.trainers.length} trainer${page.trainers.length===1?'':'s'}${live?' · live updates':''}`}</p>
    <div aria-busy={loading}>
      {page.trainers.length?<ul className="lobby-list">{page.trainers.map(trainer=><li key={trainer.id}>
        <span className="trainer-avatar" aria-hidden="true"><UserRound /><i className="online-dot" /></span><div><strong>@{trainer.handle}</strong><p>{trainer.version==='firered'?'FireRed':'LeafGreen'}{trainer.maxLevel!==null?` · party up to Lv. ${trainer.maxLevel}`:''}</p>
          {(trainer.party??[]).length>0&&<span className="party-preview" role="list" aria-label={`Party preview for ${trainer.handle}`}>
            {(trainer.party??[]).map((mon,index)=><span key={`${mon.species}-${index}`} role="listitem" className="party-preview-chip"><span>{mon.name}</span><em>Lv. {mon.level}</em></span>)}
          </span>}
        </div>
        <div className="trainer-row-actions">
          {trading&&<Button variant="outline" size="sm" disabled={disabled||loading} onClick={()=>onTrade(trainer.id)}><ArrowLeftRight aria-hidden="true" />Invite to trade</Button>}
          {battles&&<Button variant="secondary" size="sm" disabled={disabled||loading} onClick={()=>onChallenge(trainer.id)}><Swords aria-hidden="true" />Challenge to battle</Button>}
        </div>
      </li>)}</ul>:!loading&&<EmptyState compact icon={search||edition?Search:Users} title={search||edition||near?'No matching trainers':'A little quiet here'}>{search?'No trainers on this page match that name.':edition||near?'No trainers match these filters right now.':cursors.length>1?'No trainers remain on this page. Go back to see earlier names.':'No other trainers are here yet.'}</EmptyState>}
    </div>
    <nav className="trainer-pagination" aria-label="Trainer pages">
      <Button variant="outline" size="sm" disabled={disabled||loading||cursors.length===1} onClick={()=>{setLoading(true);setCursors(values=>values.slice(0,-1));}}><ChevronLeft aria-hidden="true" />Previous trainers</Button>
      <Button variant="outline" size="sm" disabled={disabled||loading||!page.nextCursor} onClick={()=>{if(page.nextCursor){setLoading(true);setCursors(values=>[...values,page.nextCursor!]);}}}>Next trainers<ChevronRight aria-hidden="true" /></Button>
      <Button variant="ghost" size="sm" disabled={disabled||loading} onClick={()=>{setLoading(true);setRefreshToken(value=>value+1);}}><RefreshCw aria-hidden="true" />Refresh trainers</Button>
    </nav>
    <p className="lobby-note">Search ignores letter case. Only trainers currently waiting in the lobby appear. Party levels come from each trainer's saved game.</p>
    <p className="lobby-note">{trading?'Both trainers review their offers before starting the original trade scene.':'Trade invitations are being qualified.'} {battles?'Battle with your own party at the levels earned on your adventure.':'Battle challenges are being qualified.'}</p>
  </LobbyPanel>;
}
