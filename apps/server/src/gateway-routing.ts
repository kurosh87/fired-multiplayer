import {createHash} from 'node:crypto';
import {assertRecord,DomainError,GAME_VERSIONS} from '../../../packages/protocol/index.ts';

export type GatewayNode={id:string;origin:string};
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export function routingId(value:unknown):string{
  if(typeof value!=='string'||!uuid.test(value))throw new DomainError('INVALID_ROUTE','Choose a valid game connection.');
  return value.toLowerCase();
}
export function gatewayNodes(value:unknown):readonly GatewayNode[]{
  if(!Array.isArray(value)||value.length<1||value.length>128)throw new Error('Configure 1–128 gateway worker nodes.');
  const ids=new Set<string>(),origins=new Set<string>();
  return Object.freeze(value.map(entry=>{
    assertRecord(entry);
    if(Object.keys(entry).some(key=>!['id','origin'].includes(key))||typeof entry.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,31}$/.test(entry.id)
      ||typeof entry.origin!=='string')throw new Error('Each worker needs a stable id and an exact HTTP(S) origin.');
    let url:URL;try{url=new URL(entry.origin);}catch{throw new Error('Each worker needs an exact HTTP(S) origin.');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
      throw new Error('Worker origins cannot contain credentials, paths, queries or fragments.');
    if(url.port==='0')throw new Error('Worker ports must be between 1 and 65535.');
    if(ids.has(entry.id)||origins.has(url.origin))throw new Error('Worker ids and origins must be unique.');
    ids.add(entry.id);origins.add(url.origin);return Object.freeze({id:entry.id,origin:url.origin});
  }).sort((a,b)=>a.id.localeCompare(b.id)));
}

/** Rendezvous routing is independent of configuration order. Node ids are
 * stable logical workers; topology changes require a deliberate drain. */
export function gatewayNode(nodes:readonly GatewayNode[],key:string):GatewayNode{
  if(!nodes.length)throw new Error('Gateway has no worker nodes.');
  let selected=nodes[0]!,score:Buffer|undefined;
  for(const node of nodes){
    const candidate=createHash('sha256').update(key).update('\0').update(node.id).digest();
    if(!score||Buffer.compare(candidate,score)>0||candidate.equals(score)&&node.id<selected.id){selected=node;score=candidate;}
  }
  return selected;
}
/** Static battle routes are owner-scoped; only a real battle id pins work to
 * the worker that hosts that battle's original consoles. */
const staticBattlePaths=new Set(['/api/battles/challenge','/api/battles/quick','/api/battles/quick/cancel','/api/battles/live']);
export function httpRoutingKey(path:string,owner:string):string{
  const battle=staticBattlePaths.has(path)?null:/^\/api\/battles\/([^/]+)(?:\/[^/]+)?$/.exec(path);
  return battle?`battle:${routingId(decodeURIComponent(battle[1]!))}`:`owner:${routingId(owner)}`;
}
export function socketRoutingKey(path:string,owner:string,message:unknown):string{
  assertRecord(message);
  if(message.type!=='authenticate'||message.protocol!==1||typeof message.token!=='string'||!message.token.length||message.token.length>8185)
    throw new DomainError('UNAUTHENTICATED','Authenticate your game connection.',401);
  if(path==='/api/battle-play')return `battle:${routingId(message.battleId)}`;
  // Directory presence is an owner-scoped stream: one node per account, no
  // session or battle id needed.
  if(path==='/api/lobby-play')return `owner:${routingId(owner)}`;
  routingId(message.sessionId);
  if(message.mode!==undefined&&message.mode!=='trade')throw new DomainError('INVALID_ROUTE','Choose a valid game connection.');
  if(message.mode==='trade')routingId(message.tradeId);
  return `owner:${routingId(owner)}`;
}
export function publicGatewayPath(path:string):boolean{
  return path==='/api/status'||/^\/api\/engines\/(firered|leafgreen)\/(?:manifest|artifact|[a-f0-9]{64}\.wasm)$/.test(path);
}

/** Readiness must not pair a manifest from one deployment with game bytes
 * from another. This is a routing check, not release qualification. */
export function workerArtifactSignature(value:unknown):string|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const status=value as Record<string,unknown>;
  if(status.protocol!==1||status.accountsConfigured!==true||!Array.isArray(status.engines)||status.engines.length!==2)return;
  const artifacts=[];
  for(const version of GAME_VERSIONS){
    const entries=status.engines.filter(entry=>entry?.version===version);
    if(entries.length!==1)return;const entry=entries[0],manifest=entry.manifest;
    if(entry.available!==true||!manifest||manifest.version!==version||typeof manifest.id!=='string'||!manifest.id
      ||typeof manifest.wasmSha256!=='string'||!/^[a-f0-9]{64}$/.test(manifest.wasmSha256))return;
    artifacts.push([version,manifest.id,manifest.wasmSha256]);
  }
  return createHash('sha256').update(JSON.stringify(artifacts)).digest('hex');
}
