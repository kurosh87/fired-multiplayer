import type {FastifyInstance} from 'fastify';
import type {WebSocket} from 'ws';
import {assertRecord,DomainError,PROTOCOL_VERSION,type LobbyTrainer} from '../../../packages/protocol/index.ts';
import type {LiveBattle} from '../../../packages/battles/protocol.ts';
import type {LobbyPresenceMessage} from './lobby-presence.ts';
import {SocketAuthLease} from './socket-auth.ts';
import {monitorSocketHeartbeat} from './socket-heartbeat.ts';

/** The streaming half of the presence service. Structural so the socket
 * contract can be exercised without a database or listener. */
export type LobbyPresenceLike={
  readonly started:boolean;
  start():Promise<void>;
  snapshot():LobbyTrainer[];
  liveSnapshot?():LiveBattle[]|undefined;
  subscribe(subscriber:(message:LobbyPresenceMessage)=>void):()=>void;
};

/** The directory stream is read-only: authenticate, receive sync/put/del and
 * periodically renew the same account. It never accepts game input, and a
 * trainer never sees their own directory row. Clients keep polling whenever
 * the socket is unavailable, so this path stays additive. */
export function registerLobbyApi(app:FastifyInstance,presence:LobbyPresenceLike|undefined,origin:string,
  owner:(authorization:string|undefined)=>Promise<string>,
  ensureLobby:(ownerId:string)=>Promise<void>):()=>Promise<void>{
  const connections=new Map<string,WebSocket>();
  app.get('/api/lobby-play',{websocket:true},(socket,request)=>{
    if(request.headers.origin!==origin){socket.close(1008,'Origin not allowed');return;}
    monitorSocketHeartbeat(socket);
    // Fail closed: a server without the presence service keeps every client on
    // its page poll. The listener itself starts with the first such connection.
    if(!presence){socket.close(1013,'Live presence is unavailable');return;}
    const service=presence;
    let ownerId:string|undefined,active=true,pending=0,unsubscribe:(()=>void)|undefined;
    let tail=Promise.resolve();
    const deadline=setTimeout(()=>socket.close(1008,'Authentication required'),10_000);
    const send=(body:unknown)=>{if(active&&socket.readyState===1)socket.send(JSON.stringify(body));};
    const authentication=new SocketAuthLease(()=>send({type:'auth-required',protocol:1}),
      ()=>{active=false;socket.close(1008,'Reconnect to refresh authentication');});
    const deliver=(id:string,message:LobbyPresenceMessage)=>{
      if(message.type==='put'){if(message.trainer.id!==id)send({protocol:PROTOCOL_VERSION,...message});return;}
      if(message.type==='del'){if(message.ownerId!==id)send({protocol:PROTOCOL_VERSION,...message});return;}
      if(message.type==='live'){send({protocol:PROTOCOL_VERSION,...message});return;}
      send({protocol:PROTOCOL_VERSION,...message,trainers:message.trainers.filter(trainer=>trainer.id!==id)});
    };
    socket.on('message',(raw,isBinary)=>{
      if(isBinary||++pending>4){socket.close(1008,'Invalid presence message');return;}
      tail=tail.then(async()=>{
        if(!active)return;
        const body:unknown=JSON.parse(raw.toString());assertRecord(body);
        if(!ownerId){
          if(body.type!=='authenticate'||body.protocol!==PROTOCOL_VERSION||typeof body.token!=='string'
            ||Object.keys(body).some(key=>!['type','protocol','token'].includes(key)))
            throw new DomainError('UNAUTHENTICATED','Authenticate the presence connection.',401);
          const id=await owner(`Bearer ${body.token}`);
          if(!active)return;
          // Directory visibility matches the HTTP page: live lobby trainers only.
          await ensureLobby(id);
          if(!active)return;
          if(!service.started){
            try{await service.start();}
            catch{
              send({type:'error',error:'PRESENCE_UNAVAILABLE',message:'Live presence is unavailable. The directory keeps polling.'});
              active=false;authentication.close();
              socket.close(1013,'Live presence is unavailable');
              return;
            }
            if(!active)return;
          }
          ownerId=id;
          const previous=connections.get(id);
          if(previous&&previous!==socket)previous.close(1008,'Presence resumed in another window');
          connections.set(id,socket);
          clearTimeout(deadline);
          authentication.start();
          send({type:'ready',protocol:PROTOCOL_VERSION});
          deliver(id,{type:'sync',trainers:service.snapshot()});
          const live=service.liveSnapshot?.();
          if(live)send({type:'live',protocol:PROTOCOL_VERSION,battles:live});
          unsubscribe=service.subscribe(message=>deliver(id,message));
        }else if(body.type==='refresh-auth'){
          if(await authentication.refresh(body,ownerId,owner))send({type:'auth-refreshed',protocol:1});
        }else throw new DomainError('INVALID_MESSAGE','The presence connection only refreshes authentication.');
      }).catch(error=>{
        send({type:'error',error:error instanceof DomainError?error.code:'CONNECTION_ERROR',
          message:error instanceof DomainError?error.message:'Reconnect to the lobby.'});
        active=false;authentication.close();
        socket.close(1008,'Reconnect to the lobby');
      }).finally(()=>{pending--;});
    });
    socket.on('close',()=>{
      active=false;clearTimeout(deadline);authentication.close();unsubscribe?.();
      if(ownerId&&connections.get(ownerId)===socket)connections.delete(ownerId);
    });
  });
  return async()=>{for(const connection of connections.values())connection.close(1001,'Server restarting');};
}
