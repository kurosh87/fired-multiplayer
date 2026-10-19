import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync,gunzipSync } from 'node:zlib';
import type { Database } from '../apps/server/src/database.ts';
import { WasmEngine } from '../packages/engine/runtime.ts';
import { OriginalTradeCore,type PartyMon } from '../packages/trading/original-core.ts';
import { originalGameProvider } from './original-game-provider.ts';
import { checkTradeUi } from './trade-ui-qualification.ts';

const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const identity=(mon:PartyMon)=>({species:mon.species,personality:mon.personality,trainerId:mon.trainerId,
  level:mon.level,hp:mon.hp,maxHp:mon.maxHp,heldItem:mon.heldItem,isEgg:mon.isEgg,moves:mon.moves,pp:mon.pp});

/** Joins retained, input-earned original-C adventures to the actual browser
 * lobby/trade/Continue journey. Only the initial durable fixture is seeded;
 * all subsequent transitions use production HTTP/WS and player controls. */
export async function checkEarnedTradeJourney(database:Database,owners:[string,string],saves:[string,string]){
  const tag=process.env.KANTO_UI_EVIDENCE_TAG??'earned-trade-journey';assert(/^[a-z0-9-]{1,32}$/.test(tag));
  assert(process.env.KANTO_UI_EVIDENCE_TAG,'Set a fresh KANTO_UI_EVIDENCE_TAG for retained journey evidence.');
  const output=`build/${tag}-journey-report.json`;assert(!existsSync(output));
  const registry=await originalGameProvider(false,true),versions=['firered','leafgreen'] as const;
  const names=new Map<string,Map<number,string>>();
  const sources:any[]=[],sourceParties:PartyMon[][]=[],storageHashes:string[]=[],committed:any[]=[],returned:any[]=[];
  await database.pool.query('savepoint earned_trade_journey');
  try{
    for(const [side,version] of versions.entries()){
      const manifest=registry.manifest(version),bytes=registry.artifact(version),directory=`build/game-source/${version}/audio-16`;
      const qualification=JSON.parse(await readFile(`${directory}/audio-report.json`,'utf8'));
      const original=JSON.parse(await readFile(`build/adventure-qualification/${version}-storage/report.json`,'utf8'));
      const replayPath=`tests/replays/${version}-audio-pc-storage.json`,replayBytes=await readFile(replayPath),replay=JSON.parse(replayBytes.toString());
      const bridgePath=`build/adventure-exploration/${version}/storage-field-return/report.json`,bridgeBytes=await readFile(bridgePath),bridge=JSON.parse(bridgeBytes.toString());
      assert.equal(manifest.id,qualification.artifactId);assert.equal(sha(bytes),qualification.wasmSha256);
      const section=WebAssembly.Module.customSections(await WebAssembly.compile(Uint8Array.from(bytes)),'name')[0];assert(section);
      names.set(version,functionNames(new Uint8Array(section)));
      const engine=await WasmEngine.create(bytes,manifest,replay.seed);
      let checkpoint:Buffer,flash:Buffer,frame:number;
      try{
        engine.restore(new Uint8Array(await readFile(`${directory}/route-audio-pc-desktop.checkpoint`)));
        assert.equal(engine.digest(),qualification.digest);assert.equal(engine.frame,qualification.fullAdventureReplayFrames);
        for(const run of bridge.runs)engine.advance([run]);
        const c=engine.bindExtension<any>('kanto_lobby_save_abi_version',1,['ArePlayerFieldControlsLocked','ScriptContext_IsEnabled']);
        assert.equal(c.ArePlayerFieldControlsLocked(),0);assert.equal(c.ScriptContext_IsEnabled(),0);
        flash=Buffer.from(engine.flash());assert.equal(sha(flash),qualification.savedPhases.withdraw.flashSha256);
        assert.equal(sha(flash),original.phases.withdraw.flashSha256);assert(original.phases.withdraw.originalGbaReadback);
        frame=engine.frame;checkpoint=gzipSync(registry.encodeCheckpoint(version,engine.snapshot()),{level:1});
      }finally{engine.close();}
      const inspector=await OriginalTradeCore.create(bytes,manifest,replay.seed,flash);
      try{
        const party=inspector.party();assert.equal(party.length,2);assert.deepEqual(party.map(mon=>mon.species),[1,19]);assert(party.every(mon=>!mon.badEgg));
        for(let slot=0;slot<2;slot++)for(const key of ['species','personality','trainerId','level','hp','maxHp','checksum','moves'] as const)
          assert.deepEqual(party[slot]![key],original.phases.withdraw.state.party[slot][key]);
        sourceParties.push(party);storageHashes.push(storageHash(inspector));
      }finally{inspector.close();}
      await database.pool.query("update private.game_sessions set status='closed',superseded_at=clock_timestamp() where owner_id=$1",[owners[side]]);
      const save=(await database.pool.query('update private.adventures set flash=$2,revision=revision+1 where id=$1 and owner_id=$3 returning revision',[saves[side],flash,owners[side]])).rows[0];assert(save);
      const sessionId=randomUUID();
      await database.pool.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,initial_flash,base_revision,status,frame,next_sequence,checkpoint,checkpoint_frame,checkpoint_sequence,lease_expires_at)
        values($1,$2,$3,$4,$5,$6,$7,'adventure',$8,0,$9,$8,0,clock_timestamp()-interval '1 second')`,
        [sessionId,owners[side],saves[side],manifest.id,replay.seed,flash,save.revision,frame,checkpoint]);
      sources.push({version,artifactId:manifest.id,startingFrame:frame,sourceDigest:qualification.digest,sourceFlashSha256:sha(flash),
        replay:replayPath,replaySha256:sha(replayBytes),fieldReturn:bridgePath,fieldReturnSha256:sha(bridgeBytes),party:sourceParties[side]!.map(identity),storageSha256:storageHashes[side],originalGbaSourceSaveAccepted:true});
    }
    assert.notEqual(sourceParties[0]![1]!.personality,sourceParties[1]![1]!.personality,'The caught Pokémon must be distinguishable across the trade.');
    const verifyParty=(side:number,party:PartyMon[])=>{
      assert.equal(party.length,2);assert(party.every(mon=>!mon.badEgg));
      assert.deepEqual(identity(party[0]!),identity(sourceParties[side]![0]!),'Trading replaced or changed the earned starter.');
      assert.deepEqual(identity(party[1]!),identity(sourceParties[1-side]![1]!),'The received Pokémon differs from the peer\'s caught Rattata.');
    };
    await checkTradeUi(database,registry,owners,saves,{earnedJourney:true,expectedOffer:'RATTATA',inspectCommitted:async rows=>{
      for(const [side,version] of versions.entries()){
        const save=rows.find(row=>row.id===saves[side]);assert(save);
        const core=await OriginalTradeCore.create(registry.artifact(version),registry.manifest(version),0,save.flash);
        try{verifyParty(side,core.party());assert.equal(storageHash(core),storageHashes[side]);committed.push({version,revision:Number(save.revision),flashSha256:sha(save.flash),party:core.party().map(identity),storageSha256:storageHash(core)});}
        finally{core.close();}
      }
    }});
    for(const [side,version] of versions.entries()){
      const save=(await database.pool.query('select revision,flash from private.adventures where id=$1',[saves[side]])).rows[0];assert(save);
      const point=(await database.pool.query("select checkpoint,seed,frame from private.game_sessions where owner_id=$1 and adventure_id=$2 and status='closed' and superseded_at is null order by updated_at desc limit 1",[owners[side],saves[side]])).rows[0];assert(point);
      const engine=await WasmEngine.create(registry.artifact(version),registry.manifest(version),Number(point.seed));
      let position:number[]=[],map:number[]=[];
      try{
        engine.restore(registry.decodeCheckpoint(version,gunzipSync(point.checkpoint)));
        const c=engine.bindExtension<any>('kanto_lobby_save_abi_version',1,['ArePlayerFieldControlsLocked','ScriptContext_IsEnabled','IsOverworldRunning','CB1_Overworld']);
        const before=engine.digest(),memory=new DataView(c.memory.buffer),main=c.gMain.value,saveBlock=memory.getUint32(c.gSaveBlock1Ptr.value,true);
        const raw=c.__indirect_function_table.get(memory.getUint32(main,true)).name;
        const callback=names.get(version)!.get(Number(raw))??raw;
        // Binaryen's reviewed --fpcast-emu pass inserts an exact callback
        // adapter. Compare its retained symbolic target, not JS function identity.
        assert(['CB1_Overworld','byn$fpcast-emu$CB1_Overworld'].includes(callback),`Continue installed ${callback}, not the original overworld callback.`);
        assert(c.IsOverworldRunning(),'The original overworld is not running after Continue.');
        assert.equal(c.ArePlayerFieldControlsLocked(),0,'Continue did not return to the field.');assert.equal(c.ScriptContext_IsEnabled(),0);
        position=[memory.getInt16(saveBlock,true),memory.getInt16(saveBlock+2,true)];map=[memory.getUint8(saveBlock+4),memory.getUint8(saveBlock+5)];
        assert.equal(engine.digest(),before,'Field inspection changed canonical state.');
        assert.equal(sha(engine.flash()),sha(save.flash));
      }finally{engine.close();}
      const core=await OriginalTradeCore.create(registry.artifact(version),registry.manifest(version),Number(point.seed),save.flash);
      await mkdir(`build/${tag}`,{recursive:true});
      try{
        verifyParty(side,core.party());assert.equal(storageHash(core),storageHashes[side]);
        const partyBytes=Buffer.concat(core.party().map(mon=>Buffer.from(core.monBytes(mon.slot))));
        const c=core.engine.bindExtension<any>('kanto_lobby_save_abi_version',1,[]),pointer=new DataView(c.memory.buffer).getUint32(c.gPokemonStoragePtr.value,true);
        await writeFile(`build/${tag}/${version}-returned-party.bin`,partyBytes);await writeFile(`build/${tag}/${version}-returned-storage.bin`,new Uint8Array(c.memory.buffer,pointer,0x83d0));
        returned.push({version,revision:Number(save.revision),frame:Number(point.frame),flashSha256:sha(save.flash),party:core.party().map(identity),partySha256:sha(partyBytes),storageSha256:storageHash(core),map,position,continuedToUnlockedField:true,actualOverworldCallback:true});
      }
      finally{core.close();}
      await writeFile(`build/${tag}/${version}-returned.sav`,save.flash);await writeFile(`build/${tag}/${version}-returned.checkpoint.gz`,point.checkpoint);
    }
    await writeFile(output,JSON.stringify({sources,committed,returned,realOriginalC:true,realPostgres:true,actualHttpWebSocket:true,
      earnedCatchAndPcSource:true,actualBrowserLobbyEntry:true,atomicCrossVersionTrade:true,distinctCaughtPokemonExchanged:true,
      earnedStartersPreserved:true,recordedStoragePreserved:true,originalContinueToFieldAfterTrade:true,
      authProvider:'isolated local confirmed-email fixture',hostedAccountsQualified:false,physicalDevicesQualified:false,
      postTradeIndependentGbaReadback:false,fullAdventureQualified:false,publicReleaseQualified:false,
      scope:'Continues retained input-earned desktop checkpoints; does not replay the full initial adventure through the network or prove hosted account signup.'},null,2)+'\n');
    console.log(JSON.stringify({earnedTradeJourney:true,ordinaryCrossVersion:true,originalContinueToField:true}));
  }finally{await database.pool.query('rollback to savepoint earned_trade_journey');await database.pool.query('release savepoint earned_trade_journey');}
}

function storageHash(core:OriginalTradeCore):string{
  const c=core.engine.bindExtension<any>('kanto_lobby_save_abi_version',1,[]),before=core.engine.digest();
  const pointer=new DataView(c.memory.buffer).getUint32(c.gPokemonStoragePtr.value,true);
  const result=sha(new Uint8Array(c.memory.buffer,pointer,0x83d0));assert.equal(core.engine.digest(),before);return result;
}

function functionNames(bytes:Uint8Array):Map<number,string>{
  let cursor=0;
  const uint=()=>{let value=0,shift=0,byte:number;do{assert(cursor<bytes.length);byte=bytes[cursor++]!;value|=(byte&127)<<shift;shift+=7;assert(shift<=35);}while(byte&128);return value>>>0;};
  const result=new Map<number,string>();
  while(cursor<bytes.length){
    const kind=bytes[cursor++]!,length=uint(),end=cursor+length;assert(end<=bytes.length);
    if(kind===1){const count=uint();for(let i=0;i<count;i++){const index=uint(),size=uint();assert(cursor+size<=end);result.set(index,new TextDecoder().decode(bytes.subarray(cursor,cursor+size)));cursor+=size;}}
    cursor=end;
  }
  return result;
}
