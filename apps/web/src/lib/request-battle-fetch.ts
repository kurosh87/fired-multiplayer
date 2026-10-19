import { token, ApiError } from '../api.ts';
import { accountCredentials, cloudAccountsEnabled } from '../account-session.ts';
import { MAX_BATTLE_RESPONSE_BYTES } from '../../../../packages/battles/request-protocol.ts';

/** HTTP battles use the application's same-origin authenticated boundary. */
export async function requestBattleFetch(path:string,body:unknown,signal:AbortSignal,binary=false):Promise<unknown>{
  const accessToken=await token(),generation=accountCredentials.generation;
  const response=await fetch('/api/online/battles/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',signal,
    headers:{Authorization:'Bearer '+accessToken,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(cloudAccountsEnabled&&generation!==accountCredentials.generation)throw new ApiError('ACCOUNT_CHANGED','Your signed-in account changed. Reopen your adventure.',401);
  if(!response.ok){
    const value=await response.json();throw new ApiError(value.error??'REQUEST_FAILED',value.message??'Your battle could not connect.',response.status);
  }
  const unchanged=()=>{if(cloudAccountsEnabled&&generation!==accountCredentials.generation)throw new ApiError('ACCOUNT_CHANGED','Your signed-in account changed. Reopen your adventure.',401);};
  if(!binary){const value=await response.json();unchanged();return value;}
  if(response.headers.get('Content-Type')?.split(';')[0]!=='application/vnd.kanto.battle-response')throw new Error('The battle response format is invalid.');
  const reader=response.body?.getReader();if(!reader)throw new Error('The battle response is empty.');
  const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.length;
    if(length>MAX_BATTLE_RESPONSE_BYTES){await reader.cancel();throw new Error('The battle response is too large.');}chunks.push(item.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}unchanged();return bytes;
}
