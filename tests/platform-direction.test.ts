import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gameVersion} from '../packages/protocol/index.ts';
import {GAME_CATALOG} from '../packages/games/catalog.ts';
import {assessOriginal151,crossGenerationRoute,type BridgePokemon} from '../packages/games/compatibility.ts';
import {utcWeek,weeklyScoreboard,type CommunityEvent} from '../packages/community/scoreboard.ts';

test('research games cannot enter the existing GBA engine/save protocol',()=>{
  assert.equal(GAME_CATALOG.soulsilver.browser,'research');assert.equal(GAME_CATALOG.heartgold.generation,4);
  assert.throws(()=>gameVersion('soulsilver'),{code:'INVALID_VERSION'});
  assert.deepEqual(crossGenerationRoute('soulsilver','firered'),{allowedDirection:true,executable:false,reason:'CONVERTER_NOT_QUALIFIED'});
  assert.equal(crossGenerationRoute('leafgreen','heartgold').allowedDirection,false);
});
test('a first-151 species still needs compatible moves, ability, record conversion and ownership',()=>{
  const mon:BridgePokemon={nationalDex:25,form:0,egg:false,level:30,moves:[85,0,0,0],ability:9,heldItem:null};
  const oracle={moveAllowed:(s:number,m:number)=>s===25&&m===85,abilityAllowed:(s:number,a:number)=>s===25&&a===9};
  assert(assessOriginal151(mon).problems.some(p=>p.code==='TARGET_DATA_UNVERIFIED'));
  assert.equal(assessOriginal151(mon,oracle).policyPass,true);assert.equal(assessOriginal151(mon,oracle).executable,false);
  for (const patch of [{nationalDex:152},{moves:[369,0,0,0]},{ability:98},{form:1},{egg:true},{heldItem:'mail'},{moves:[1,0,0,0]},{level:NaN}])
    assert.equal(assessOriginal151({...mon,...patch},oracle).policyPass,false,JSON.stringify(patch));
});
test('weekly scoreboard uses Monday UTC across year and daylight-saving boundaries',()=>{
  assert.deepEqual(utcWeek('2027-01-03T23:59:59Z'),{start:'2026-12-28T00:00:00.000Z',end:'2027-01-04T00:00:00.000Z'});
  assert.equal(utcWeek('2026-03-08T23:30:00-07:00').start,'2026-03-09T00:00:00.000Z');
});
test('community policy deduplicates receipts/species and caps opponent farming; uploads and aborts earn nothing',()=>{
  const base={owner:'alice',occurredAt:'2026-10-13T12:00:00Z',verified:true};
  const caught:CommunityEvent={...base,id:'catch',kind:'pokedex-owned',nationalDex:25};
  const events:CommunityEvent[]=[caught,caught,{...caught,id:'same-species-another-game'},
    {...caught,id:'uploaded-species',nationalDex:26,verified:false},
    ...[1,2,3].map(n=>({...base,id:'win'+n,kind:'battle-win' as const,battleId:'battle'+n,opponent:'bob',format:'kanto',outcome:'completed' as const})),
    {...base,id:'aborted',kind:'battle-win',battleId:'aborted',opponent:'bob',format:'kanto',outcome:'aborted'},
    {...base,id:'old-catch',kind:'pokedex-owned',nationalDex:1,occurredAt:'2026-10-01T12:00:00Z'},
    {...base,id:'recaught',kind:'pokedex-owned',nationalDex:1}];
  assert.deepEqual(weeklyScoreboard(events,'2026-10-16').rows,[{owner:'alice',points:25,badges:0,newSpecies:1,battleWins:2}]);
  assert.throws(()=>weeklyScoreboard([caught,{...caught,nationalDex:26}],'2026-10-16'),/Conflicting/);
});
