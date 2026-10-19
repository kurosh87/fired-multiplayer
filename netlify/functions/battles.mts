import type {Config,Context} from '@netlify/functions';
import {getConnectionString} from '@netlify/database';
import {createNetlifyBattles,privateBattleOrigin} from '../../apps/server/src/netlify-battles.ts';

let service:ReturnType<typeof createNetlifyBattles>|undefined;
export default async function handler(request:Request,context:Context){
  const origin=privateBattleOrigin(request,{siteId:context.site.id??'',context:context.deploy.context});
  const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
  if(!origin)return Response.json({error:'BATTLES_UNAVAILABLE',message:'Online battles are undergoing private testing.'},{status:503,headers});
  try{
    service??=createNetlifyBattles(getConnectionString(),Netlify.env.get('BETTER_AUTH_SECRET')??'');
    return await service.fetch(request,origin);
  }catch{
    return Response.json({error:'BATTLES_UNAVAILABLE',message:'Battle services are temporarily unavailable.'},{status:503,headers});
  }
}

export const config:Config={path:['/api/online/battles','/api/online/battles/*'],
  rateLimit:{windowLimit:900,windowSize:60,aggregateBy:['ip','domain']}};
