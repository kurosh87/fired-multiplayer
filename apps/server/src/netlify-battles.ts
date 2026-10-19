import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {Database} from './database.ts';
import {createBetterAuthAuthenticator} from './account-auth.ts';
import {requestBattleHttp} from './request-battle-http.ts';
import {RequestBattles} from './request-battles.ts';
import {EngineRegistry} from '../../../packages/engine/registry.ts';
import {PRIVATE_BATTLE_PINS} from '../../../packages/battles/private-artifacts.ts';
import {BattleConsolePool} from '../../../packages/battles/console-pool.ts';

const SITE='kanto-online-preview.netlify.app';
export type BattleDeployment={siteId:string;context:string};
export function privateBattleOrigin(request:Request,deployment:BattleDeployment):string|undefined{
  const url=new URL(request.url);
  if(deployment.siteId!=='4fcf6389-9abb-4239-8134-d99fa08b85d8'
    || !['deploy-preview','branch-deploy'].includes(deployment.context)
    || url.protocol!=='https:' || url.port || !new RegExp(`^[a-f0-9]{24}--${SITE.replaceAll('.','\\.')}$`).test(url.hostname))return;
  return url.origin;
}

/** No test provider, email endpoints, clock override or fixture seeding exists
 * in this service. Warm pools cache code/connections only, never consoles. */
export function createNetlifyBattles(connectionString:string,secret:string,runtimeDirectory=resolve('build/netlify-battle-runtime')){
  const game=new Database(connectionString,()=>{},'netlify',{managedGameRole:true});
  const accounts=new pg.Pool({connectionString,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:10000,
    statement_timeout:5000,application_name:'kanto-battle-accounts'});
  accounts.on('error',()=>{});
  const registry=new EngineRegistry();
  let loading:Promise<void>|undefined;
  const ready=()=>loading??=(async()=>{
    await registry.loadPrivateBattle(runtimeDirectory,PRIVATE_BATTLE_PINS);
    if(registry.status().some(item=>!item.available))throw new Error('Private battle artifacts unavailable.');
  })().catch(error=>{loading=undefined;throw error;});
  const workers=new BattleConsolePool(1,{
    url:pathToFileURL(resolve(runtimeDirectory,'battle-worker.mjs')),transport:'thread',
  });
  const service=new RequestBattles(game,registry,{workerFactory:()=>workers.scope()});
  const origins=new Map<string,ReturnType<typeof requestBattleHttp>>();
  return {
    async fetch(request:Request,origin:string):Promise<Response>{
      let endpoint=origins.get(origin);
      if(!endpoint){
        const authenticate=createBetterAuthAuthenticator(accounts,origin,secret);
        endpoint=requestBattleHttp(service,async authorization=>{
          const owner=await authenticate(authorization);
          await ready();
          return owner;
        },origin);
        if(origins.size>=4)origins.clear();origins.set(origin,endpoint);
      }
      return endpoint(request);
    },
    async close(){await workers.close();await Promise.all([game.close(),accounts.end()]);},
  };
}
