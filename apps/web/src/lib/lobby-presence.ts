import {API_URL,token} from '../api.ts';
import {maintainSocketAuthentication} from './socket-auth.ts';
import type {LobbyPresenceMessage} from './lobby-directory.ts';
import type {LobbyTrainer} from '../../../../packages/protocol/index.ts';
import type {LiveBattle} from '../../../../packages/battles/protocol.ts';

export type {LobbyPresenceMessage} from './lobby-directory.ts';

/** Live directory socket. Read-only: authenticate, then receive sync/put/del.
 * Every reconnect rebuilds from the server's next sync, and when the socket is
 * unavailable the page poll above keeps working unchanged. */
export function openLobbyPresence(onEvent:(message:LobbyPresenceMessage)=>void,onState?:(state:'live'|'offline')=>void):()=>void{
  let disposed=false,socket:WebSocket|undefined,stopAuth:(()=>void)|undefined,retry:ReturnType<typeof setTimeout>|undefined;
  let delay=2_000;
  const schedule=()=>{
    if(disposed||retry)return;
    retry=setTimeout(()=>{retry=undefined;connect();},delay);
    delay=Math.min(delay*2,30_000);
  };
  const connect=()=>{
    if(disposed)return;
    const url=new URL('/api/lobby-play',API_URL);
    url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const connection=new WebSocket(url);
    socket=connection;
    stopAuth=maintainSocketAuthentication(connection,token);
    connection.onopen=()=>{
      void token().then(accessToken=>{
        if(!disposed&&connection.readyState===1)connection.send(JSON.stringify({type:'authenticate',protocol:1,token:accessToken}));
      }).catch(()=>connection.close(1008,'Sign in again to continue'));
    };
    connection.onmessage=(event:MessageEvent)=>{
      if(typeof event.data!=='string')return;
      let body:{type?:string;protocol?:number;trainers?:LobbyTrainer[];trainer?:LobbyTrainer;ownerId?:string;battles?:LiveBattle[]};
      try{body=JSON.parse(event.data) as typeof body;}catch{return;}
      if(!body||body.protocol!==1)return;
      if(body.type==='ready'){delay=2_000;onState?.('live');return;}
      if(body.type==='sync'&&Array.isArray(body.trainers))onEvent({type:'sync',trainers:body.trainers});
      else if(body.type==='put'&&body.trainer)onEvent({type:'put',trainer:body.trainer});
      else if(body.type==='del'&&typeof body.ownerId==='string')onEvent({type:'del',ownerId:body.ownerId});
      else if(body.type==='live'&&Array.isArray(body.battles))onEvent({type:'live',battles:body.battles});
    };
    connection.onclose=()=>{
      stopAuth?.();stopAuth=undefined;
      if(socket===connection)socket=undefined;
      if(disposed)return;
      onState?.('offline');
      schedule();
    };
  };
  connect();
  return()=>{
    disposed=true;clearTimeout(retry);retry=undefined;
    stopAuth?.();stopAuth=undefined;
    const connection=socket;socket=undefined;
    connection?.close(1000,'Leaving the lobby');
  };
}
