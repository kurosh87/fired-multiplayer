import { Card } from './components/ui/card.tsx';
import { Badge } from './components/ui/badge.tsx';
import { LobbyPanel } from './components/lobby-panel.tsx';
import { StatusMessage } from './components/status-message.tsx';
import { Button } from './components/ui/button.tsx';
import { ArrowLeftRight, ArrowUpRight, CircleDot, Swords, Users, Zap } from 'lucide-react';
import { EmptyState } from './components/empty-state.tsx';
import { Field, FieldLabel } from './components/ui/field.tsx';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.tsx';
import { useEffect, useRef, useState } from 'react';
import './trades.css';
import { api, ApiError } from './api.ts';
import { battleApi, httpBattles } from './lib/battle-api.ts';
import type { LobbyState, SessionBootstrap } from '../../server/src/sessions.ts';
import type { LobbyTrainerPage } from '../../../packages/protocol/index.ts';
import type { TradeView, PublicTradeOffer } from '../../../packages/trading/offers.ts';
import type { TradeSceneBootstrap } from '../../server/src/trade-scenes.ts';
import type {BattleView, LiveBattle, WatchSide} from '../../../packages/battles/protocol.ts';
import type {QuickMatchStatus} from '../../server/src/quick-match.ts';
import {TrainerDirectory} from './trainer-directory.tsx';

function elapsed(since:number,now:number){
  const total=Math.max(0,Math.floor((now-since)/1000));
  return `${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;
}

export function Lobby({ authenticated, available, trading=false, battles=false, onBattle, onWatch, onAdventures, onResume }: { authenticated: boolean; available: boolean; trading?: boolean; battles?:boolean; onBattle?(battle:BattleView):void;
  onWatch?(battle:LiveBattle,side:WatchSide):void;
  onAdventures(): void; onResume(bootstrap: SessionBootstrap | TradeSceneBootstrap): void }) {
  const [lobby, setLobby] = useState<LobbyState>();
  const [trainerPage,setTrainerPage]=useState<LobbyTrainerPage>({trainers:[],nextCursor:null});
  const [loading, setLoading] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');
  const [trades,setTrades] = useState<TradeView[]>([]);
  const [challenges,setChallenges]=useState<BattleView[]>([]);
  const [liveBattles,setLiveBattles]=useState<LiveBattle[]>([]);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [quick,setQuick]=useState<'idle'|'searching'>('idle');
  const [quickSince,setQuickSince]=useState<number|undefined>(undefined);
  const [clock,setClock]=useState(Date.now());
  const [watchable,setWatchable]=useState(false);
  const requestEpoch=useRef(0);
  const interaction=trades.some(trade=>trade.status==='committing')||challenges.some(battle=>['starting','active'].includes(battle.status));
  const quickBattle=challenges.find(battle=>['starting','active'].includes(battle.status));
  const myLevel=Math.max(0,...(lobby?.party??[]).filter(mon=>!mon.isEgg).map(mon=>mon.level));
  useEffect(() => {
    let current = true;
    if (!available || !authenticated) {
      setLobby(undefined);setTrainerPage({trainers:[],nextCursor:null});setTrades([]);setChallenges([]);setLiveBattles([]);setNotice('');setError('');setLoading(false);return;
    }
    setLoading(true);
    void api<{ trades:TradeView[] }>('/api/trades').then(result=>{if(current)setTrades(result.trades);}).catch(failure=>{if(current)setError(failure.message);});
    void api<{ lobby: LobbyState } & LobbyTrainerPage>('/api/lobby').then(result => {
      if (current) { setLobby(result.lobby);setTrainerPage({trainers:result.trainers,nextCursor:result.nextCursor});setError(''); }
    }).catch(failure => {
      if (current && !(failure instanceof ApiError && failure.code === 'LOBBY_NOT_FOUND')) setError(failure.message);
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [authenticated, available]);
  useEffect(()=> {
    if (!available || !authenticated) return;
    let current=true;
    const timer=setInterval(()=> {
      if (document.hidden || busy || leaving) return;
      const epoch=requestEpoch.current;
      void api<{trades:TradeView[]}>('/api/trades').then(result=>{if(current&&epoch===requestEpoch.current)setTrades(result.trades);}).catch(failure=>{if(current&&epoch===requestEpoch.current)setError(failure.message);});
    },5000);
    return ()=>{current=false;clearInterval(timer);};
  },[available,authenticated,busy,leaving]);
  useEffect(()=>{
    if(!available||!authenticated||!battles)return;
    let current=true;
    const refresh=()=>{
      if(document.hidden||busy||leaving)return;
      const epoch=requestEpoch.current;
      void battleApi<{battles:BattleView[]}>('').then(value=>{if(current&&epoch===requestEpoch.current)setChallenges(value.battles);})
        .catch(failure=>{if(current&&epoch===requestEpoch.current)setError(failure.message);});
    };
    refresh();const timer=setInterval(refresh,5000);return()=>{current=false;clearInterval(timer);};
  },[available,authenticated,battles,busy,leaving]);
  useEffect(()=>{
    if(!available||!authenticated||!battles||httpBattles)return;
    let current=true;
    const refresh=()=>{
      if(document.hidden||busy||leaving)return;
      const epoch=requestEpoch.current;
      void battleApi<{battles:LiveBattle[]}>('/live').then(value=>{if(current&&epoch===requestEpoch.current)setLiveBattles(value.battles);})
        .catch(()=>{/* The live list is advisory; polling and the lobby stay usable. */});
    };
    refresh();const timer=setInterval(refresh,5000);return()=>{current=false;clearInterval(timer);};
  },[available,authenticated,battles,busy,leaving]);
  useEffect(()=>{
    if(!available||!authenticated||!battles||httpBattles)return;
    let current=true;
    const refresh=()=>{
      if(document.hidden||busy||leaving)return;
      const epoch=requestEpoch.current;
      void battleApi<QuickMatchStatus>('/quick').then(value=>{
        if(!current||epoch!==requestEpoch.current)return;
        if(value.status==='waiting'){setQuick('searching');setQuickSince(value.enqueuedAt);}
        else {setQuick('idle');setQuickSince(undefined);}
      }).catch(()=>{/* The next poll retries; the queue row is unchanged. */});
    };
    refresh();const timer=setInterval(refresh,5000);return()=>{current=false;clearInterval(timer);};
  },[available,authenticated,battles,busy,leaving]);
  useEffect(()=>{
    if(quick!=='searching')return;
    setClock(Date.now());
    const timer=setInterval(()=>setClock(Date.now()),1000);
    return()=>clearInterval(timer);
  },[quick]);
  async function action(body:()=>Promise<void>) {
    if(busy)return;requestEpoch.current++;setBusy(true);setError('');setNotice('');
    try {await body();}catch(failure){setError(failure instanceof Error?failure.message:'The invitation could not be updated.');}
    finally{setBusy(false);}
  }
  function update(trade:TradeView) {
    setTrades(current=>[trade,...current.filter(item=>item.id!==trade.id)].filter(item=>['offered','committing'].includes(item.status)));
  }
  async function invite(id:string) {await action(async()=>update(await api<TradeView>('/api/trades',{trainerId:id})));}
  async function pick(trade:TradeView,slot:number) {
    const mon=lobby?.party.find(item=>item.slot===slot);if(!mon||!lobby)return;
    await action(async()=>update(await api<TradeView>(`/api/trades/${trade.id}/offer`,{
      offerRevision:trade.offerRevision,partySlot:slot,pokemonDigest:mon.digest,saveRevision:lobby.saveRevision })));
  }
  async function play(trade:TradeView) {
    await action(async()=> {
      const result=await api<TradeSceneBootstrap | {tradeId:string}>(`/api/trades/${trade.id}/scene`,{offerRevision:trade.offerRevision});
      if('mode' in result) onResume(result);
      else {setNotice('Trade complete. Continue your adventure to see your updated party.');setTrades(current=>current.filter(item=>item.id!==trade.id));setLobby(undefined);}
    });
  }
  function offered(offer:PublicTradeOffer|null) {
    const mon=offer?.pokemon;
    return mon?<><strong>{mon.isEgg?'Egg':mon.nickname}</strong><p>{mon.isEgg?'An unhatched Egg':`${mon.speciesName} · Lv. ${mon.level} · ${mon.hp}/${mon.maxHp} HP`}</p></>:<p>Choosing a Pokémon…</p>;
  }
  async function leave() {
    setLeaving(true); setError('');
    try { onResume(await api<SessionBootstrap>('/api/lobby/leave', {})); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Your adventure could not resume.'); setLeaving(false); }
  }
  return <section className="empty-view lobby-view">
    <p className="eyebrow accent">MEET OTHER TRAINERS</p><h1>{lobby ? 'Welcome to the lobby.' : <>Your next rival<br />is out there.</>}</h1>
    <p>{lobby ? 'Your adventure is saved and paused while you are here.' : 'Battle with your own team. Trade with trainers playing either version.'}</p>
    {error && <StatusMessage destructive className="game-error">{error}</StatusMessage>}
    {notice && <StatusMessage>{notice}</StatusMessage>}
    {challenges.length>0&&<div className="trade-invitations"><h2>Battle challenges</h2>{challenges.map(battle=><LobbyPanel key={battle.id}
      title={`@${battle.playerA.handle} vs @${battle.playerB.handle}`} headingLevel={3} icon={Swords}
      description={`Singles · original levels · unranked${battle.watchable?' · spectators allowed':''}`}
      status={<Badge variant="secondary">{battle.status==='offered'?'Invitation':'In progress'}</Badge>}
      footer={<div className="lobby-toolbar">
        {battle.status==='offered'&&battle.side==='a'&&<p>Waiting for your opponent to accept…</p>}
        {battle.status==='offered'&&battle.side==='b'&&<Button size="sm" disabled={busy||interaction} onClick={()=>void action(async()=>{
          const result=await battleApi<{battle:BattleView}>(`/${battle.id}/accept`,{});onBattle?.(result.battle);
        })}>Accept battle</Button>}
        {['starting','active'].includes(battle.status)&&<Button size="sm" disabled={busy} onClick={()=>void action(async()=>{
          const result=await battleApi<{battle:BattleView}>(`/${battle.id}${httpBattles?'':'/open'}`,httpBattles?undefined:{});onBattle?.(result.battle);
        })}>Continue battle</Button>}
        {battle.status==='offered'&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void action(async()=>{
          await battleApi(`/${battle.id}/decline`,{});setChallenges(items=>items.filter(item=>item.id!==battle.id));
        })}>Decline challenge</Button>}
      </div>} />)}</div>}
    {trades.length>0 && <div className="trade-invitations"><h2>Trade invitations</h2>{trades.map(trade=> {
      const mine=trade.side==='a'?trade.offerA:trade.offerB;
      const confirmed=trade.side==='a'?trade.confirmedA:trade.confirmedB;
      return <LobbyPanel className="trade-card" key={trade.id} title={`@${trade.playerA.handle} ↔ @${trade.playerB.handle}`}
        headingLevel={3} icon={ArrowLeftRight} description="One Pokémon each. Review both offers together."
        status={<Badge variant="secondary">{trade.status==='committing'?'Ready':confirmed?'Confirmed':'Review offers'}</Badge>}
        footer={<div className="lobby-toolbar">
          {trade.status==='offered' && <Button size="sm" disabled={busy||confirmed||!trade.offerA||!trade.offerB} onClick={()=>void action(async()=>update(await api<TradeView>(`/api/trades/${trade.id}/confirm`,{offerRevision:trade.offerRevision})))}>{confirmed?'Confirmed':'Confirm both offers'}</Button>}
          {(trade.status==='committing'||trade.confirmedA&&trade.confirmedB) && <Button size="sm" disabled={busy} onClick={()=>void play(trade)}>{trade.status==='committing'?'Continue trade':'Play trade scene'}</Button>}
          <Button variant="ghost" size="sm" disabled={busy} onClick={()=>void action(async()=> {
            update(await api<TradeView>(`/api/trades/${trade.id}/cancel`,{}));
            const result=await api<{lobby:LobbyState}&LobbyTrainerPage>('/api/lobby');setLobby(result.lobby);setTrainerPage(result);
          })}>{trade.status==='committing'?'Cancel trade':'Decline'}</Button>
        </div>}>
        <div className="lobby-columns"><div className="trade-offer"><p>Your offer</p>{offered(mine)}</div><div className="trade-offer"><p>Their offer</p>{offered(trade.side==='a'?trade.offerB:trade.offerA)}</div></div>
        {trade.status==='offered' && lobby && <Field><FieldLabel htmlFor={`offer-${trade.id}`}>Choose from your party</FieldLabel><NativeSelect id={`offer-${trade.id}`} aria-label="Pokémon to offer" value={mine?.partySlot??''} disabled={busy} onChange={event=>void pick(trade,Number(event.target.value))}>
          <NativeSelectOption value="" disabled>Choose a Pokémon</NativeSelectOption>{lobby.party.map(mon=><NativeSelectOption key={mon.slot} value={mon.slot}>{mon.slot+1}. {mon.isEgg?'Egg':`${mon.nickname} · Lv. ${mon.level}`}</NativeSelectOption>)}
        </NativeSelect></Field>}
        <p>{trade.status==='committing'?'Your original trade scene is ready to continue.':confirmed?'Your offer is confirmed. A changed offer needs both confirmations again.':'Review both Pokémon before confirming.'}</p>
      </LobbyPanel>;
    })}</div>}
    {loading ? <Card className="empty-panel gap-0" role="status">Restoring your lobby session…</Card> : lobby ? <>
      <div className="lobby-toolbar"><Badge variant="outline"><CircleDot aria-hidden="true" />{lobby.version === 'firered' ? 'FireRed' : 'LeafGreen'}</Badge>
        <Button size="lg" onClick={() => void leave()} disabled={leaving||interaction||busy}>{leaving ? 'Resuming…' : 'Return to adventure'}<ArrowUpRight aria-hidden="true" /></Button></div>
      {!httpBattles&&<LobbyPanel className="quick-match" title="Quick Match" icon={Zap} headingLevel={2}
        description="Battle the closest trainer who is also looking for one right now."
        status={<Badge variant="secondary">{quickBattle?'Match ready':quick==='searching'?'Searching':'Ready'}</Badge>}
        footer={<div className="lobby-toolbar">
          {quickBattle?<Button size="sm" disabled={busy} onClick={()=>void action(async()=>{
            const result=await battleApi<{battle:BattleView}>(`/${quickBattle.id}${httpBattles?'':'/open'}`,httpBattles?undefined:{});setQuick('idle');setQuickSince(undefined);onBattle?.(result.battle);
          })}>Open match</Button>
          :quick==='searching'?<><p role="status">{myLevel>0?`Looking for a trainer near Lv. ${myLevel}…`:'Looking for a trainer…'}</p>{quickSince!==undefined&&<p className="lobby-note">Waiting {elapsed(quickSince,clock)}</p>}<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void action(async()=>{await battleApi('/quick/cancel',{});setQuick('idle');setQuickSince(undefined);})}>Stop searching</Button></>
          :<Button size="sm" disabled={busy||interaction} onClick={()=>void action(async()=>{
            const result=await battleApi<{status:string;bootstrap?:{battle:BattleView}}>('/quick',{});
            if(result.status==='paired'&&result.bootstrap){setQuick('idle');setQuickSince(undefined);onBattle?.(result.bootstrap.battle);}
            else {setQuick('searching');setQuickSince(Date.now());}
          })}><Swords aria-hidden="true" />Find a battle</Button>}
        </div>}>
        <p>Both trainers queue up and the server pairs the closest waiting party. You fight with your saved team at the levels you earned.</p>
      </LobbyPanel>}
      {liveBattles.length>0&&<div className="trade-invitations"><h2>Live battles</h2>{liveBattles.map(battle=><LobbyPanel key={battle.id}
        title={`@${battle.playerA.handle} vs @${battle.playerB.handle}`} headingLevel={3} icon={Swords}
        description="Watch the rendered battle screen live. No saves or controls are shared."
        status={<Badge variant="secondary"><CircleDot aria-hidden="true" />Live</Badge>}
        footer={<div className="lobby-toolbar"><Button size="sm" disabled={busy} onClick={()=>onWatch?.(battle,'a')}>Watch battle</Button>
          <p>You can switch sides while watching.</p></div>}>
        <p>Both sides run on the game server. Spectators receive pixels only.</p>
      </LobbyPanel>)}</div>}
      <div className="lobby-columns"><LobbyPanel title="Your party" icon={CircleDot} description="The team you raised on your adventure."
        status={<Badge variant="outline">{lobby.party.length} / 6</Badge>}><ul className="lobby-list">
        {lobby.party.map(mon => <li key={mon.slot}><span className="party-slot">{mon.slot + 1}</span><div><strong>{mon.isEgg ? 'Egg' : mon.nickname || mon.speciesName}</strong>
          <p>{mon.isEgg ? 'Keep it with you on your adventure.' : `${mon.speciesName} · Lv. ${mon.level} · ${mon.hp}/${mon.maxHp} HP`}</p></div></li>)}
      </ul></LobbyPanel><TrainerDirectory key={lobby.sessionId} initialPage={trainerPage} disabled={leaving||busy||interaction} trading={trading} battles={battles}
        watchable={watchable} myLevel={myLevel} onWatchableChange={setWatchable} onLive={setLiveBattles}
        onTrade={id=>void invite(id)} onChallenge={id=>void action(async()=>{
          const battle=await battleApi<BattleView>(httpBattles?'':'/challenge',{trainerId:id,watchable});setChallenges(items=>[battle,...items.filter(item=>item.id!==battle.id)]);
        })}/></div>
    </> : <EmptyState icon={Users} title={available ? 'Enter from your adventure' : 'The online lobby is being built'} action={<Button size="lg" onClick={onAdventures}>Back to adventures<ArrowUpRight aria-hidden="true" /></Button>}>
      {available ? authenticated ? 'Stand still in the field, close menus, then choose Enter online lobby. Your current progress will be saved.' : 'Sign in and choose your trainer name to join other players.' : 'Battles and trades will open after the game core and verified saves are ready.'}</EmptyState>}
  </section>;
}
