import type {FastifyInstance} from 'fastify';
import type {WebSocket} from 'ws';
import {assertRecord,DomainError} from '../../../packages/protocol/index.ts';
import {battleId as normalizeBattleId,watchChoice,type WatchSide} from '../../../packages/battles/protocol.ts';
import {BattleScreenEncoder} from '../../../packages/battles/screen.ts';
import {BattleSessions,type BattleScreenEvent} from './battle-sessions.ts';
import {QUICK_MATCH_SWEEP_MS,type QuickMatch} from './quick-match.ts';
import {SocketAuthLease} from './socket-auth.ts';
import {monitorSocketHeartbeat} from './socket-heartbeat.ts';

const WATCHERS_PER_BATTLE=10;

/** The battle connection carries personal pixels and buttons only. Neither
 * original console, link packets nor private journals are public endpoints. */
export function registerBattleApi(app:FastifyInstance,service:BattleSessions|undefined,origin:string,
  owner:(authorization:string|undefined)=>Promise<string>,quick?:QuickMatch):()=>Promise<void>{
  const requireService=()=>{
    if(!service)throw new DomainError('SERVICE_UNCONFIGURED','Account services have not been configured.',503);
    return service;
  };
  const connections=new Map<string,{socket:WebSocket;id:string;epoch:number;encoder:BattleScreenEncoder}>();
  const watchers=new Map<string,{socket:WebSocket;battleId:string;side:WatchSide;encoder:BattleScreenEncoder}>();
  app.get('/api/battles',async request=>({battles:await requireService().list(await owner(request.headers.authorization))}));
  app.get('/api/battles/live',async request=>{
    await owner(request.headers.authorization);
    return {battles:await requireService().liveBattles()};
  });
  app.get<{Params:{id:string}}>('/api/battles/:id',async request=>requireService().get(await owner(request.headers.authorization),request.params.id));
  app.post('/api/battles/challenge',async request=>{
    const id=await owner(request.headers.authorization);assertRecord(request.body);
    if(Object.keys(request.body).some(key=>key!=='trainerId'))throw new DomainError('INVALID_CHALLENGE','Choose a trainer to challenge.');
    return requireService().challenge(id,request.body.trainerId as string);
  });
  for(const action of ['accept','open','decline','forfeit'] as const)
    app.post<{Params:{id:string}}>(`/api/battles/:id/${action}`,async request=>{
      const id=await owner(request.headers.authorization);assertRecord(request.body);
      if(Object.keys(request.body).length)throw new DomainError('INVALID_BATTLE','This action takes no game state.');
      return requireService()[action](id,request.params.id);
    });
  const requireQuick=()=>{
    if(!quick)throw new DomainError('SERVICE_UNCONFIGURED','Account services have not been configured.',503);
    return quick;
  };
  app.post('/api/battles/quick',async request=>{
    const id=await owner(request.headers.authorization);assertRecord(request.body);
    if(Object.keys(request.body).length)throw new DomainError('INVALID_BATTLE','This action takes no game state.');
    return requireQuick().enqueue(id);
  });
  app.post('/api/battles/quick/cancel',async request=>{
    const id=await owner(request.headers.authorization);assertRecord(request.body);
    if(Object.keys(request.body).length)throw new DomainError('INVALID_BATTLE','This action takes no game state.');
    return requireQuick().cancel(id);
  });
  const screen=(event:BattleScreenEvent)=>{
    const connection=connections.get(event.ownerId);
    if(connection?.id===event.id&&connection.socket.readyState===1){
      // Keep codec state intact: never drop an encoded delta. A slow connection
      // reconnects with a fresh keyframe instead of building an unbounded queue.
      if(connection.socket.bufferedAmount>512*1024)connection.socket.close(1013,'Reconnect for a fresh screen');
      else{
        const packet=connection.encoder.encode(event.pixels,event.frame);
        if(packet)connection.socket.send(packet,{binary:true});
      }
    }
    const side=event.side===0?'a':'b';
    for(const watcher of watchers.values()){
      if(watcher.battleId!==event.id||watcher.side!==side||watcher.socket.readyState!==1)continue;
      if(watcher.socket.bufferedAmount>512*1024){watcher.socket.close(1013,'Reconnect to watch this battle');continue;}
      const packet=watcher.encoder.encode(event.pixels,event.frame);
      if(packet)watcher.socket.send(packet,{binary:true});
    }
  };
  const finished=(event:{id:string;owners:string[];result:unknown})=>{
    for(const id of event.owners){const connection=connections.get(id);
      if(connection?.id===event.id&&connection.socket.readyState===1){
        connection.socket.send(JSON.stringify({type:'finished',protocol:1,result:event.result}));
        connection.socket.close(1000,'Battle complete');
      }
    }
    for(const [id,watcher] of watchers){
      if(watcher.battleId!==event.id)continue;
      watchers.delete(id);
      if(watcher.socket.readyState===1){
        watcher.socket.send(JSON.stringify({type:'finished',protocol:1,result:event.result}));
        watcher.socket.close(1000,'Battle complete');
      }
    }
  };
  const recover=(event:{id:string;owners:string[]})=>{
    for(const id of event.owners){const connection=connections.get(id);
      if(connection?.id===event.id)connection.socket.close(1012,'Restore verified battle progress');}
    for(const [id,watcher] of watchers){
      if(watcher.battleId!==event.id)continue;
      watchers.delete(id);
      watcher.socket.close(1012,'Restore verified battle progress');
    }
  };
  service?.on('screen',screen);service?.on('finished',finished);service?.on('recovery-required',recover);
  service?.on('run-error',event=>app.log.error({err:event.error,battleId:event.id},'Original battle needs recovery'));
  let tickTimer:ReturnType<typeof setInterval>|undefined,expiryTimer:ReturnType<typeof setInterval>|undefined,
    quickTimer:ReturnType<typeof setInterval>|undefined;
  app.addHook('onReady',async()=>{
    if(!service)return;
    tickTimer=setInterval(()=>void service.tick().catch(err=>app.log.error({err},'Battle clock failed')),16).unref();
    expiryTimer=setInterval(()=>void service.expire().catch(err=>app.log.error({err},'Battle expiry failed')),30_000).unref();
    // Re-attempts pairing for entries a request race or failed start missed,
    // and expires abandoned queue entries so they never pair later.
    if(quick)quickTimer=setInterval(()=>void quick.sweep().catch(err=>app.log.error({err},'Quick match sweep failed')),QUICK_MATCH_SWEEP_MS).unref();
  });
  app.get('/api/battle-play',{websocket:true},(socket,request)=>{
    if(request.headers.origin!==origin){socket.close(1008,'Origin not allowed');return;}
    monitorSocketHeartbeat(socket);
    let ownerId:string|undefined,battleId:string|undefined,epoch:number|undefined,active=true,pending=0,watching=false;
    let tail=Promise.resolve(),windowStart=Date.now(),count=0;
    const deadline=setTimeout(()=>socket.close(1008,'Authentication required'),10_000);
    const send=(body:unknown)=>{if(active&&socket.readyState===1)socket.send(JSON.stringify(body));};
    const authentication=new SocketAuthLease(()=>send({type:'auth-required',protocol:1}),
      ()=>{active=false;socket.close(1008,'Reconnect to refresh authentication');});
    socket.on('message',(raw,isBinary)=>{
      if(isBinary||++pending>12){socket.close(1008,'Invalid battle controls');return;}
      if(Date.now()-windowStart>=1000){windowStart=Date.now();count=0;}
      if(++count>120){socket.close(1008,'Too many battle controls');return;}
      tail=tail.then(async()=>{
        if(!active)return;
        const body:unknown=JSON.parse(raw.toString());assertRecord(body);
        if(!ownerId){
          if(body.type!=='authenticate'||body.protocol!==1||typeof body.token!=='string'||typeof body.battleId!=='string')
            throw new DomainError('UNAUTHENTICATED','Authenticate your battle connection.',401);
          const side='watch' in body?watchChoice(body.watch):undefined;
          if(Object.keys(body).some(key=>!['type','protocol','token','battleId',...(side?['watch']:[])].includes(key)))
            throw new DomainError('UNAUTHENTICATED','Authenticate your battle connection.',401);
          const id=await owner(`Bearer ${body.token}`),service=requireService();
          if(side){
            const observed=normalizeBattleId(body.battleId);
            let observers=0;for(const watcher of watchers.values())if(watcher.battleId===observed)observers++;
            // A returning spectator replaces its own slot instead of being
            // locked out by a full battle.
            if(observers>=WATCHERS_PER_BATTLE&&!watchers.has(id)){
              send({type:'error',error:'WATCH_LIMIT',message:'This battle already has the maximum number of watchers.'});
              active=false;authentication.close();socket.close(1013,'Too many watchers');return;
            }
            const previous=watchers.get(id);previous?.socket.close(1008,'Watch resumed in another window');
            const encoder=new BattleScreenEncoder();
            watchers.set(id,{socket,battleId:observed,side,encoder});
            ownerId=id;battleId=observed;watching=true;
            const watched=await service.watch(id,observed,side);
            if(!active){if(watchers.get(id)?.socket===socket)watchers.delete(id);return;}
            clearTimeout(deadline);authentication.start();
            send({type:'ready',protocol:1,frame:watched.frame,battle:watched.battle});
            const packet=encoder.encode(watched.pixels,watched.frame);
            if(packet&&socket.readyState===1)socket.send(packet,{binary:true});
            return;
          }
          const view=await service.get(id,body.battleId);
          if(view.status==='finished'){send({type:'finished',protocol:1,result:view.result});socket.close(1000,'Battle complete');return;}
          const connection=await service.connect(id,body.battleId);
          ownerId=id;battleId=body.battleId;epoch=connection.epoch;
          if(!active){await service.disconnect(id,battleId,epoch);return;}
          const previous=connections.get(id);previous?.socket.close(1008,'Battle resumed in another window');
          connections.set(id,{socket,id:battleId,epoch,encoder:new BattleScreenEncoder()});clearTimeout(deadline);
          authentication.start();
          send({type:'ready',protocol:1,nextSequence:connection.nextSequence,frame:connection.frame});
          screen({...await service.screen(id,battleId),id:battleId,ownerId:id,side:view.side==='a'?0:1});
        }else if(watching){
          if(body.type==='refresh-auth'){
            if(await authentication.refresh(body,ownerId,owner))send({type:'auth-refreshed',protocol:1});
          }else throw new DomainError('WATCH_READ_ONLY','Watching is read-only.');
        }else if(body.type==='refresh-auth'){
          if(await authentication.refresh(body,ownerId,owner))send({type:'auth-refreshed',protocol:1});
        }else send(await requireService().input(ownerId,battleId!,epoch!,body));
      }).catch(error=>{
        send({type:'error',error:error instanceof DomainError?error.code:'CONNECTION_ERROR',
          message:error instanceof DomainError?error.message:'Reconnect to your verified battle.'});
        active=false;authentication.close();
        socket.close(1008,watching?'Watching ended':'Restore verified battle progress');
      }).finally(()=>{pending--;});
    });
    socket.on('close',()=>{
      active=false;clearTimeout(deadline);authentication.close();
      if(ownerId&&connections.get(ownerId)?.socket===socket)connections.delete(ownerId);
      if(ownerId&&watchers.get(ownerId)?.socket===socket)watchers.delete(ownerId);
      void tail.then(()=>ownerId&&!watching&&epoch!==undefined?service?.disconnect(ownerId,battleId!,epoch):undefined)
        .catch(err=>{if(!(err instanceof DomainError&&['BATTLE_CHANGED','BATTLE_RUN_NOT_FOUND'].includes(err.code)))app.log.error({err},'Battle disconnect failed');});
    });
  });
  return async()=>{
    clearInterval(tickTimer);clearInterval(expiryTimer);clearInterval(quickTimer);
    for(const connection of connections.values())connection.socket.close(1001,'Server restarting');
    for(const watcher of watchers.values())watcher.socket.close(1001,'Server restarting');
    await service?.close();
    service?.removeListener('screen',screen);service?.removeListener('finished',finished);service?.removeListener('recovery-required',recover);
  };
}
