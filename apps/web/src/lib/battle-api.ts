import {api} from '../api.ts';
import {requestBattleFetch} from './request-battle-fetch.ts';
const transport=import.meta.env.VITE_BATTLE_TRANSPORT??'socket';
if(!['socket','http'].includes(transport))throw new Error('Choose a supported battle transport.');
export const httpBattles=transport==='http';
export async function battleApi<T>(path:string,body?:unknown):Promise<T>{
  return httpBattles?await requestBattleFetch(path.replace(/^\//,''),body,AbortSignal.timeout(12_000)) as T:api<T>('/api/battles'+path,body);
}
