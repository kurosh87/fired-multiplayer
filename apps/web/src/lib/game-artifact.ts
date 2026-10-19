import type {GameVersion} from '../../../../packages/protocol/index.ts';
import {gameArtifactUrl} from '../../../../packages/engine/artifact-url.ts';

export const GAME_ARTIFACT_CACHE='kanto-game-artifacts-v1';
const MAX_CACHED_GAMES=4;
const contentAddressed=(path:string)=>/^\/(?:api\/engines|preview-data)\/(firered|leafgreen)\/[a-f0-9]{64}\.wasm$/.test(path);
const digest=async(bytes:ArrayBuffer)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');

export async function downloadGameArtifact(base:string,path:string,sha256:string,signal:AbortSignal):Promise<ArrayBuffer>{
  if(!/^[a-f0-9]{64}$/.test(sha256))throw new Error('The game download is unavailable. Please reload.');
  const url=`${base}${path}`;
  let store:Cache|undefined,corruptCache=false;
  if(contentAddressed(path)&&path.endsWith(`/${sha256}.wasm`)){
    try{
      if(typeof caches!=='undefined'){
        store=await caches.open(GAME_ARTIFACT_CACHE);
        const cached=await store.match(url);
        if(cached){
          const bytes=await cached.arrayBuffer();signal.throwIfAborted();
          const actual=await digest(bytes);signal.throwIfAborted();
          if(actual===sha256)return bytes;
          corruptCache=true;await store.delete(url);
        }
      }
    }catch{store=undefined;}
  }
  signal.throwIfAborted();
  for(let attempt=0;attempt<2;attempt++){
    const response=await fetch(url,{signal,...(attempt||corruptCache?{cache:'reload' as const}:{})});
    if(!response.ok)throw new Error('The game could not be downloaded. Please try again.');
    const bytes=await response.arrayBuffer();
    const actual=await digest(bytes);signal.throwIfAborted();
    if(actual===sha256){
      if(store)try{
        await store.put(url,new Response(bytes.slice(0),{headers:{'Content-Type':'application/wasm'}}));
        const keys=(await store.keys()).filter(key=>contentAddressed(new URL(key.url).pathname));
        for(const old of keys.filter(key=>key.url!==url).slice(0,Math.max(0,keys.length-MAX_CACHED_GAMES)))await store.delete(old);
      }catch{/* Disabled storage or quota pressure must not prevent play. */}
      signal.throwIfAborted();return bytes;
    }
    // Retry a corrupt cache entry once, bypassing that cached response.
  }
  throw new Error('The game download could not be verified. Please try again.');
}

/** Download and verify the large common asset before reserving a private
 * verifier. Session bootstrap remains authoritative if a deploy changes it. */
export async function prefetchGameArtifact(base:string,version:GameVersion,signal:AbortSignal):Promise<{bytes:ArrayBuffer;sha256:string}>{
  const response=await fetch(`${base}/api/engines/${version}/manifest`,{signal});
  if(!response.ok)throw new Error('This adventure is unavailable. Please try again shortly.');
  const discovery=await response.json();
  const hash=discovery?.manifest?.wasmSha256;
  if(discovery?.manifest?.version!==version||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)
    ||discovery.artifactUrl!==gameArtifactUrl(version,hash))
    throw new Error('The game download is unavailable. Please reload.');
  return {sha256:hash,bytes:await downloadGameArtifact(base,discovery.artifactUrl,hash,signal)};
}
