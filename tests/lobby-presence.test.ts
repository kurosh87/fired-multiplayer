import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseListener} from '../apps/server/src/database.ts';
import {LIVE_BATTLE_PREFIX,LobbyPresence,LOBBY_CHANNEL,notifyLiveBattle,type LobbyPresenceMessage} from '../apps/server/src/lobby-presence.ts';
import type {LiveBattle} from '../packages/battles/protocol.ts';

type Row={handle:string;version:string;party:unknown;maxLevel:number|null;lease:number};

class FakeDatabase{
  rows=new Map<string,Row>();
  ownerReads=0;snapshots=0;
  put(owner:string,row:Partial<Row>={}){
    this.rows.set(owner,{handle:'Scout',version:'firered',party:[],maxLevel:null,lease:Date.now()+60_000,...row});
  }
  remove(owner:string){this.rows.delete(owner);}
  query=async (_text:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>=>{
    const owners=Array.isArray(values?.[0])?(values[0] as string[]):undefined;
    if(owners)this.ownerReads+=1;else this.snapshots+=1;
    const now=Date.now();
    const matched=[...this.rows.entries()]
      .filter(([id,row])=>row.lease>now&&(!owners||owners.includes(id)))
      .sort((left,right)=>left[1].handle.toLowerCase()<right[1].handle.toLowerCase()?-1:1);
    const limited=owners?matched:matched.slice(0,Number(values?.[0]??200));
    return {rows:limited.map(([id,row])=>({owner_id:id,handle:row.handle,version:row.version,party:row.party,
      max_party_level:row.maxLevel,lease_expires_at:new Date(row.lease)}))};
  };
}

class FakeListener implements DatabaseListener{
  notifications:(payload:string)=>void=()=>{};
  errors:(error:Error)=>void=()=>{};
  closed=false;
  onNotification(handler:(payload:string)=>void){this.notifications=handler;}
  onError(handler:(error:Error)=>void){this.errors=handler;}
  async end(){this.closed=true;}
}

function harness(options:{syncThreshold?:number;live?:()=>Promise<LiveBattle[]>}={}){
  const database=new FakeDatabase();
  const listeners:FakeListener[]=[];
  const errors:Error[]=[];
  const presence=new LobbyPresence({
    listen:async()=>{const listener=new FakeListener();listeners.push(listener);return listener;},
    queries:database,
    onError:error=>errors.push(error),
    flushDelayMs:2,
    staleCheckMs:60_000,
    reconcileMs:60_000,
    reconnectMs:5,
    ...(options.live?{live:options.live}:{}),
    ...(options.syncThreshold===undefined?{}:{syncThreshold:options.syncThreshold}),
  });
  return {database,listeners,errors,presence};
}

const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
async function waitFor(predicate:()=>boolean,label:string){
  const deadline=Date.now()+2_000;
  while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}
  throw new Error(`Timed out waiting for ${label}`);
}

const owner=(suffix:number)=>`00000000-0000-4000-8000-${String(suffix).padStart(12,'0')}`;
const battle=(id:string,frame=0):LiveBattle=>({id,playerA:{handle:'Alice',version:'firered'},
  playerB:{handle:'Bob',version:'leafgreen'},frame,startedAt:1_760_000_000_000});

test('presence streams committed joins, updates and departures',async()=>{
  const {database,listeners,presence}=harness();
  database.put(owner(1),{handle:'Scout001'});
  await presence.start();
  assert.equal(presence.started,true);
  assert.deepEqual(presence.snapshot().map(trainer=>trainer.handle),['Scout001']);
  const events:LobbyPresenceMessage[]=[];
  presence.subscribe(message=>events.push(message));
  await tick();
  assert.deepEqual(events,[],'The baseline is not re-announced to a late subscriber.');

  database.put(owner(2),{handle:'Scout002',maxLevel:22});
  listeners[0]!.notifications(owner(2));
  await waitFor(()=>events.length===1,'the new trainer');
  assert.deepEqual(events[0],{type:'put',trainer:{id:owner(2),handle:'Scout002',version:'firered',party:[],maxLevel:22}});

  database.put(owner(1),{handle:'Scout001',maxLevel:31});
  listeners[0]!.notifications(owner(1));
  await waitFor(()=>events.length===2,'the update');
  assert.deepEqual(events[1],{type:'put',trainer:{id:owner(1),handle:'Scout001',version:'firered',party:[],maxLevel:31}});

  database.remove(owner(2));
  listeners[0]!.notifications(owner(2));
  await waitFor(()=>events.length===3,'the departure');
  assert.deepEqual(events[2],{type:'del',ownerId:owner(2)});

  const unsubscribe=presence.subscribe(()=>{throw new Error('A removed subscriber must not be called.');});
  unsubscribe();
  database.put(owner(3));
  listeners[0]!.notifications(owner(3));
  await waitFor(()=>events.length===4,'the third trainer');
  database.put(owner(4),{handle:'Aardvark'});
  listeners[0]!.notifications(owner(4));
  await waitFor(()=>events.length===5,'the alphabetically first trainer');
  assert.deepEqual(presence.snapshot().map(trainer=>trainer.handle),['Aardvark','Scout','Scout001'],
    'The pushed window stays in directory order however events arrive.');
  await presence.stop();
  assert.equal(presence.started,false);
  assert.equal(listeners[0]!.closed,true);
});

test('presence stays silent for unchanged rows and unrelated payloads',async()=>{
  const {database,listeners,presence}=harness();
  database.put(owner(1));
  await presence.start();
  const events:LobbyPresenceMessage[]=[];
  presence.subscribe(message=>events.push(message));
  const reads=database.ownerReads;
  listeners[0]!.notifications(owner(1));
  listeners[0]!.notifications('not-an-owner-id');
  listeners[0]!.notifications('{"changed":true}');
  await waitFor(()=>database.ownerReads>reads,'the unchanged re-read');
  await tick();
  assert.deepEqual(events,[]);
  assert.equal(database.ownerReads,reads+1,'Only the real owner id is re-read.');
  await presence.stop();
});

test('a burst of notifications becomes one row read and ordered events',async()=>{
  const {database,listeners,presence}=harness();
  await presence.start();
  const events:LobbyPresenceMessage[]=[];
  presence.subscribe(message=>events.push(message));
  database.put(owner(1),{handle:'Scout001'});
  database.put(owner(2),{handle:'Scout002'});
  const reads=database.ownerReads;
  listeners[0]!.notifications(owner(1));
  listeners[0]!.notifications(owner(2));
  listeners[0]!.notifications(owner(1));
  await waitFor(()=>events.length===2,'the coalesced flush');
  assert.equal(database.ownerReads,reads+1,'Both owners share one read.');
  assert.deepEqual(events.map(message=>message.type),['put','put']);
  await presence.stop();
});

test('an expired lease hides a trainer and a renewed lease brings it back',async()=>{
  const {database,listeners,presence}=harness();
  database.put(owner(1),{handle:'Scout001',lease:Date.now()+25});
  await presence.start();
  const events:LobbyPresenceMessage[]=[];
  presence.subscribe(message=>events.push(message));
  await tick();
  assert.deepEqual(events,[],'The known lease must lapse before anything happens.');

  database.remove(owner(1));
  await presence.verifyStale();
  assert.deepEqual(events,[{type:'del',ownerId:owner(1)}]);

  database.put(owner(1),{handle:'Scout001',lease:Date.now()+25});
  listeners[0]!.notifications(owner(1));
  await waitFor(()=>events.length===2,'the return');
  assert.deepEqual(events[1],{type:'put',trainer:{id:owner(1),handle:'Scout001',version:'firered',party:[],maxLevel:null}});

  // A lease that lapsed only locally, while the owner kept polling, must be
  // refreshed silently instead of blinking out of the directory.
  await tick();
  database.rows.get(owner(1))!.lease=Date.now()+60_000;
  await presence.verifyStale();
  await tick();
  assert.equal(events.length,2,'A live renewed lease is never re-announced.');
  assert.deepEqual(presence.snapshot().map(trainer=>trainer.handle),['Scout001']);
  await presence.stop();
});

test('reconciliation repairs missed changes and large drift becomes one sync',async()=>{
  const {database,listeners,presence}=harness({syncThreshold:40});
  database.put(owner(1),{handle:'Scout001'});
  await presence.start();
  const events:LobbyPresenceMessage[]=[];
  presence.subscribe(message=>events.push(message));
  database.put(owner(2),{handle:'Scout002',maxLevel:9});
  database.remove(owner(1));
  await presence.reconcile();
  assert.deepEqual(events,[{type:'del',ownerId:owner(1)},
    {type:'put',trainer:{id:owner(2),handle:'Scout002',version:'firered',party:[],maxLevel:9}}]);
  await presence.stop();

  const wide=harness({syncThreshold:1});
  wide.database.put(owner(1),{handle:'Scout001'});
  await wide.presence.start();
  const wideEvents:LobbyPresenceMessage[]=[];
  wide.presence.subscribe(message=>wideEvents.push(message));
  wide.database.put(owner(2),{handle:'Scout002'});
  wide.database.put(owner(3),{handle:'Scout003'});
  await wide.presence.reconcile();
  assert.equal(wideEvents.length,1);
  assert.equal(wideEvents[0]!.type,'sync');
  assert.deepEqual(wide.presence.snapshot().map(trainer=>trainer.handle),['Scout001','Scout002','Scout003']);
  await wide.presence.stop();
  assert.equal(listeners[0]!.closed,true);
});

test('a broken listener reconnects and rebases from committed state',async()=>{
  const {database,listeners,errors,presence}=harness();
  database.put(owner(1),{handle:'Scout001'});
  await presence.start();
  const events:LobbyPresenceMessage[]=[];
  presence.subscribe(message=>events.push(message));

  listeners[0]!.errors(new Error('connection lost'));
  database.put(owner(2),{handle:'Scout002'});
  await waitFor(()=>listeners.length===2,'the replacement listener');
  assert.equal(listeners[0]!.closed,true);
  assert.equal(errors.length,1);
  await waitFor(()=>events.length===1,'the rebased trainer');
  assert.deepEqual(events[0],{type:'put',trainer:{id:owner(2),handle:'Scout002',version:'firered',party:[],maxLevel:null}});
  listeners[1]!.notifications(owner(3));
  await tick();
  assert.equal(events.length,1);
  database.put(owner(3),{handle:'Scout003'});
  listeners[1]!.notifications(owner(3));
  await waitFor(()=>events.length===2,'the resumed stream');
  await presence.stop();
});

test('presence fails closed when the baseline cannot be read and retries later',async()=>{
  let attempts=0,listens=0;
  const presence=new LobbyPresence({
    listen:async()=>{listens++;return {end:async()=>{},onNotification:()=>{},onError:()=>{}};},
    queries:{query:async()=>{attempts++;if(attempts===1)throw new Error('database unavailable');return {rows:[]};}},
    onError:()=>{},
  });
  await assert.rejects(presence.start(),{message:'database unavailable'});
  assert.equal(presence.started,false);
  assert.equal(listens,0,'A failed baseline must not open a listener.');
  await Promise.all([presence.start(),presence.start()]);
  assert.equal(presence.started,true);
  assert.equal(listens,1);
  assert.equal(attempts,2,'Concurrent callers share one baseline read.');
  await presence.stop();
  assert.equal(presence.started,false);
});

test('the live battle list pushes starts and finishes without frame churn',async()=>{
  let battles:LiveBattle[]=[],reads=0;
  const {listeners,presence}=harness({live:async()=>{reads++;return battles;}});
  await presence.start();
  assert.equal(reads,1,'The baseline reads the list once before ready.');
  assert.deepEqual(presence.liveSnapshot(),[]);
  const events:LobbyPresenceMessage[]=[];
  presence.subscribe(message=>events.push(message));
  const id='00000000-0000-4000-8000-0000000000b1';

  battles=[battle(id,1)];
  listeners[0]!.notifications(`${LIVE_BATTLE_PREFIX}${id}`);
  await waitFor(()=>reads>=2,'the live read');
  await waitFor(()=>events.length===1,'the started battle');
  assert.deepEqual(events[0],{type:'live',battles:battles});

  battles=[battle(id,99)];
  listeners[0]!.notifications(`${LIVE_BATTLE_PREFIX}${id}`);
  await waitFor(()=>reads>=3,'the frame-only read');
  await tick();
  assert.equal(events.length,1,'A frame-only change is not a lobby event.');

  battles=[];
  listeners[0]!.notifications(`${LIVE_BATTLE_PREFIX}${id}`);
  await waitFor(()=>events.length===2,'the finished battle');
  assert.deepEqual(events[1],{type:'live',battles:[]});
  await presence.stop();
  assert.equal(presence.liveSnapshot(),undefined,'Stopping drops the cached list.');
});

test('a failing live reader never blocks the directory and retries later',async()=>{
  let fail=true;
  const id='00000000-0000-4000-8000-0000000000b2';
  const {database,listeners,errors,presence}=harness({live:async()=>{
    if(fail)throw new Error('battles unavailable');
    return [battle(id)];
  }});
  database.put(owner(1),{handle:'Scout001'});
  await presence.start();
  assert.equal(presence.started,true,'The directory stream still starts.');
  assert.deepEqual(presence.snapshot().map(trainer=>trainer.handle),['Scout001']);
  assert.equal(presence.liveSnapshot(),undefined,'A failed read is not an empty list.');
  assert.equal(errors.length,1);
  const events:LobbyPresenceMessage[]=[];
  presence.subscribe(message=>events.push(message));
  fail=false;
  listeners[0]!.notifications(`${LIVE_BATTLE_PREFIX}${id}`);
  await waitFor(()=>events.length===1,'the retried live list');
  assert.deepEqual(events[0],{type:'live',battles:[battle(id)]});
  await presence.stop();
});

test('reconciliation repairs a missed live-list change',async()=>{
  let battles:LiveBattle[]=[];
  const {presence}=harness({live:async()=>battles});
  await presence.start();
  const events:LobbyPresenceMessage[]=[];
  presence.subscribe(message=>events.push(message));
  battles=[battle('00000000-0000-4000-8000-0000000000b3')];
  await presence.reconcile();
  assert.deepEqual(events,[{type:'live',battles}]);
  await presence.stop();
});

test('live battle wake-ups carry the battle marker on the presence channel',async()=>{
  const calls:{text:string;values?:unknown[]}[]=[];
  const id='00000000-0000-4000-8000-0000000000b4';
  await notifyLiveBattle({query:async(text,values)=>{calls.push({text,values});return {rows:[]};}},id);
  assert.deepEqual(calls,[{text:'select pg_notify($1,$2)',values:[LOBBY_CHANNEL,`${LIVE_BATTLE_PREFIX}${id}`]}]);
});
