import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import type {FastifyInstance} from 'fastify';
import type {Database} from '../apps/server/src/database.ts';
import type {LobbyTrainerPage} from '../packages/protocol/index.ts';

/** Real SQL/API pagination, inside the disposable contract's rollback. No
 * original game or hosted account capability is inferred from these fixtures. */
export async function checkLobbyDiscovery(database:Database,app:FastifyInstance):Promise<void>{
  await database.pool.query('savepoint lobby_discovery');
  try{
    const names=[...Array.from({length:130},(_,i)=>`${i%2?'sCoUt':'Scout'}${String(i).padStart(3,'0')}`),
      'Scout997','Scout998','Scout999','Scout_One','ScoutXOne','Scout049a'];
    const ids=names.map(()=>randomUUID());
    await database.pool.query('insert into auth.users(id) select unnest($1::uuid[])',[ids]);
    await database.pool.query('insert into public.profiles(id,handle) select * from unnest($1::uuid[],$2::text[])',[ids,names]);
    await database.pool.query(`insert into private.adventures(owner_id,version)
      select id,case when ordinal%2=0 then 'firered' else 'leafgreen' end from unnest($1::uuid[]) with ordinality as v(id,ordinal)`,[ids]);
    await database.pool.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,base_revision,status,lease_expires_at)
      select gen_random_uuid(),owner_id,id,'discovery-fixture',0,revision,'lobby',clock_timestamp()+interval '60 seconds'
      from private.adventures where owner_id=any($1::uuid[])`,[ids]);
    await database.pool.query("update private.game_sessions set lease_expires_at=clock_timestamp()-interval '1 second' where owner_id=$1",[ids[130]]);
    await database.pool.query('update public.profiles set suspended_at=clock_timestamp() where id=$1',[ids[131]]);
    await database.pool.query("update private.game_sessions set status='adventure' where owner_id=$1",[ids[132]]);
    await database.pool.query("update private.game_sessions set status='closed' where owner_id=$1",[ids[135]]);
    const headers={authorization:'Bearer fixture-alice'};
    const read=async(search:string,after?:string,extra:Record<string,string>={}):Promise<LobbyTrainerPage>=>{
      const query=new URLSearchParams({search});if(after)query.set('after',after);
      for(const [key,value] of Object.entries(extra))query.set(key,value);
      const response=await app.inject({method:'GET',url:`/api/lobby/trainers?${query}`,headers});
      assert.equal(response.statusCode,200,response.body);return response.json();
    };
    const pages:LobbyTrainerPage[]=[],found:string[]=[];let cursor:string|undefined;
    do{
      const page=await read('ScOuT',cursor);pages.push(page);found.push(...page.trainers.map(trainer=>trainer.id));
      assert(page.trainers.length<=50);assert(page.trainers.every(trainer=>Object.keys(trainer).sort().join(',')==='handle,id,maxLevel,party,version'));
      cursor=page.nextCursor??undefined;assert(pages.length<=4,'The cursor stopped making progress.');
    }while(cursor);
    assert.deepEqual(pages.map(page=>page.trainers.length),[50,50,32]);
    assert.deepEqual(pages.slice(0,2).map(page=>page.nextCursor),['scout049','scout099']);
    assert.equal(new Set(found).size,132);assert.deepEqual(new Set(found),new Set([...ids.slice(0,130),ids[133],ids[134]]));
    assert.deepEqual((await read('SCOUT129')).trainers.map(trainer=>trainer.handle),['sCoUt129']);
    assert.deepEqual((await read('scout_')).trainers.map(trainer=>trainer.handle),['Scout_One'],'An underscore became a search wildcard.');
    assert.equal((await read('Alice')).trainers.length,0,'The directory included its own trainer.');
    // Presence snapshots are written at lobby entry; rows without one stay
    // visible with an empty party, and audience filters only constrain
    // snapshotted rows. Levels here are opaque fixtures, not game data.
    const snapshots:[string,number,{species:number;name:string;level:number}[]][]=[
      [ids[0]!,30,[{species:1,name:'BULBASAUR',level:30}]],
      [ids[2]!,8,[{species:16,name:'PIDGEY',level:8}]],
      [ids[4]!,55,[{species:25,name:'PIKACHU',level:55},{species:4,name:'CHARMANDER',level:12}]]];
    for(const [owner,level,party] of snapshots)
      await database.pool.query(`insert into private.lobby_presence(session_id,owner_id,version,max_party_level,party)
        select s.id,$1,a.version,$2,$3::jsonb from private.game_sessions s join private.adventures a on a.id=s.adventure_id
        where s.owner_id=$1 and s.status='lobby'`,[owner,level,JSON.stringify(party)]);
    const snapshotted=(await read('Scout000')).trainers[0]!;
    assert.equal(snapshotted.handle,'Scout000');
    assert.deepEqual(snapshotted.party,[{species:1,name:'BULBASAUR',level:30}]);
    assert.equal(snapshotted.maxLevel,30);
    const plain=(await read('Scout001')).trainers[0]!;
    assert.deepEqual(plain.party,[]);assert.equal(plain.maxLevel,null,'A trainer without a snapshot reported a party level.');
    const editions=await read('Scout',undefined,{version:'firered'});
    assert.equal(editions.trainers.length,50);assert(editions.trainers.every(trainer=>trainer.version==='firered'));
    assert(editions.nextCursor);
    const editionTail=await read('Scout',editions.nextCursor!,{version:'firered'});
    assert.equal(editionTail.trainers.length,16);assert(editionTail.trainers.every(trainer=>trainer.version==='firered'));
    const band=await read('Scout',undefined,{minLevel:'25'});
    assert.deepEqual(band.trainers.map(trainer=>trainer.handle),['Scout000','Scout004']);
    assert.deepEqual(band.trainers.map(trainer=>trainer.maxLevel),[30,55]);
    assert.deepEqual((await read('Scout',undefined,{maxLevel:'10'})).trainers.map(trainer=>trainer.handle),['Scout002']);
    assert.deepEqual((await read('Scout',undefined,{minLevel:'25',maxLevel:'30'})).trainers.map(trainer=>trainer.handle),['Scout000']);
    assert.deepEqual((await read('Scout',undefined,{minLevel:'56'})).trainers,[]);
    const target=(await read('scout129')).trainers[0]!;
    await database.pool.query(`update private.adventures set flash=(select a.flash from private.adventures a
      join private.game_sessions s on s.adventure_id=a.id join public.profiles p on p.id=s.owner_id
      where p.handle='Alice' and s.status='lobby') where owner_id=$1`,[target.id]);
    const invited=await app.inject({method:'POST',url:'/api/trades',headers,payload:{trainerId:target.id}});
    assert.equal(invited.statusCode,200,invited.body);assert.equal(invited.json().playerB.id,target.id);
    assert.equal((await app.inject({method:'POST',url:`/api/trades/${invited.json().id}/cancel`,headers,payload:{}})).statusCode,200);
    // The old cursor row can leave while another trainer arrives between
    // pages. Keyset continuation still advances beyond the departed name.
    await database.pool.query("update private.game_sessions set status='closed' where owner_id=$1",[ids[49]]);
    await database.pool.query("update private.game_sessions set status='lobby' where owner_id=$1",[ids[135]]);
    const continued=await read('scout','scout049');
    assert.equal(continued.trainers[0]!.id,ids[135]);assert.equal(continued.trainers[1]!.id,ids[50]);
    assert(continued.trainers.every(trainer=>trainer.handle.toLowerCase()>'scout049'));
    for(const suffix of ['search=%25','search=_','search='+('A'.repeat(17)),'after=a','after=%27%20or%201%3D1','search=Scout&search=Alice','limit=100000',
      'search=Scout&version=kanto','search=Scout&minLevel=0','search=Scout&maxLevel=101','search=Scout&minLevel=90&maxLevel=10',
      'search=Scout&minLevel=abc','search=Scout&minLevel=1&minLevel=2','search=Scout&version=firered&version=leafgreen']){
      const response=await app.inject({method:'GET',url:'/api/lobby/trainers?'+suffix,headers});
      assert.equal(response.statusCode,400,response.body);assert.equal(response.json().error,'INVALID_TRAINER_SEARCH');
    }
    assert.equal((await app.inject({method:'GET',url:'/api/lobby/trainers?search=Scout'})).statusCode,401);
    assert.equal((await app.inject({method:'GET',url:'/api/lobby/trainers?search=Scout',headers:{authorization:'Bearer fixture-unconfirmed'}})).statusCode,403);
    assert.equal((await app.inject({method:'GET',url:'/api/lobby/trainers?search=Scout',headers:{authorization:'Bearer fixture-bob'}})).statusCode,409);
    await writeFile('build/lobby-discovery-report.json',JSON.stringify({realPostgres:true,realApi:true,
      authProvider:'isolated local fixture',candidateTrainers:136,visibleTrainers:132,pageSizes:pages.map(page=>page.trainers.length),
      caseInsensitivePrefix:true,literalUnderscore:true,after100Discoverable:true,expiredSuspendedBusyAndOwnExcluded:true,
      discoveredTrainerTradeInvite:true,
      presencePartySnapshotVisible:true,emptyPresenceStaysDiscoverable:true,editionFilter:true,levelBandFilter:true,
      invalidFilterValuesRejected:true,
      departedCursorAndNewArrival:true,privateFieldsExcluded:true,malformedQueriesRejected:true,
      anonymousUnconfirmedAndOutsideLobbyRejected:true,hostedAccountsQualified:false,capacity1000Qualified:false,publicReleaseQualified:false},null,2)+'\n');
  }finally{await database.pool.query('rollback to savepoint lobby_discovery');}
}
