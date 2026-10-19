import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync,gzipSync } from 'node:zlib';
import { OriginalBattleCore } from '../packages/battles/original-core.ts';
import { transferBattleBlocks } from '../packages/battles/transport.ts';
import { OriginalTradeCore } from '../packages/trading/original-core.ts';
import { WasmEngine } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline,decodeCheckpoint,encodeCheckpoint } from '../packages/engine/checkpoint.ts';
import type { EngineManifest } from '../packages/engine/runtime.ts';

const guard=resolve(process.env.HOME??'','.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)
  process.exit(spawnSync(guard,['--',process.execPath,'--experimental-strip-types',...process.argv.slice(1)],{stdio:'inherit'}).status??1);
const directory=resolve(process.argv[2]??'build/game-source/firered/battle');
const peerDirectory=resolve(process.argv[3]??directory);
async function artifact(path:string){return {bytes:new Uint8Array(await readFile(resolve(path,'candidate.wasm'))),
  manifest:JSON.parse(await readFile(resolve(path,'candidate.json'),'utf8')) as EngineManifest};}
const first=await artifact(directory),second=await artifact(peerDirectory);
const partyFixture=process.env.KANTO_BATTLE_PARTY_FIXTURE;
async function cartridge(path:string,side:'a'|'b'){
  if(!partyFixture)return new Uint8Array(await readFile(resolve(path,'../gameplay.sav')));
  assert.match(partyFixture,/^[a-z-]+$/);
  const base=await artifact(resolve(path,'..'));
  const stem=resolve(path,'../exchange-checks',`${partyFixture}-${side}`);
  const meta=JSON.parse(await readFile(`${stem}-inputs.json`,'utf8'));
  assert.equal(meta.artifactId,base.manifest.id,'The pre-trade fixture must match its original source artifact.');
  const engine=await WasmEngine.create(base.bytes,base.manifest,meta.seed);
  try{
    const baseline=await createCheckpointBaseline(await WebAssembly.compile(base.bytes));
    engine.restore(decodeCheckpoint(new Uint8Array(gunzipSync(await readFile(`${stem}-start.checkpoint.gz`))),baseline,base.manifest.wasmSha256));
    return engine.flash();
  }finally{engine.close();}
}
const saveA=await cartridge(directory,'a'),saveB=await cartridge(peerDirectory,'b');
const sourceParties=[];
for(const [side,artifact] of [first,second].entries()){
  const inspector=await OriginalTradeCore.create(artifact.bytes,artifact.manifest,2301,side===0?saveA:saveB);
  try{sourceParties.push(inspector.party());}finally{inspector.close();}
}
let cores=[await OriginalBattleCore.create(first.bytes,first.manifest,2301,saveA,0),
  await OriginalBattleCore.create(second.bytes,second.manifest,2301,saveB,1)];
const a=cores[0]!.hello(),b=cores[1]!.hello();
assert.equal(b.byteLength,36);
const wrongPeer=b.slice();new DataView(wrongPeer.buffer).setUint16(32,0,true);
assert.throws(()=>cores[0]!.start(wrongPeer),{code:'INVALID_BATTLE_PARTNER'});
cores[0]!.start(b);cores[1]!.start(a);
let blocks=0,recovered=false,masterIntro=false,damageObserved=false,forcedSwitchObserved=false;
let recoveredInSwitch=false;
let initialHp:number[]|undefined;
const packetHash=createHash('sha256');
const inputs:[number,number][]=[];
let transportBoundsChecked=false;
const header=await readFile(resolve('vendor/pokefirered-native/include/battle_controllers.h'),'utf8');
const commands=header.slice(header.indexOf('enum')).match(/\bCONTROLLER_[A-Z0-9_]+\b/g)!;
const choosePokemon=commands.indexOf('CONTROLLER_CHOOSEPOKEMON');
assert(choosePokemon>0);
const battleConstants=await readFile(resolve('vendor/pokefirered-native/include/constants/battle.h'),'utf8');
const terrain=Number(/^#define\s+BATTLE_TERRAIN_BUILDING\s+(\d+)\b/m.exec(battleConstants)?.[1]);
assert(Number.isInteger(terrain));
const events:unknown[]=[];
const stem=`battle${first.manifest.version!==second.manifest.version?'-'+second.manifest.version:''}${partyFixture?'-'+partyFixture:''}`;
const recoveries:{point:string;frames:number[];bytes:number[]}[]=[];
const baselines=new Map<string,Uint8Array>();
const names=new Map<string,Map<number,string>>();
for(const artifact of [first,second])if(!names.has(artifact.manifest.id)){
  const section=WebAssembly.Module.customSections(await WebAssembly.compile(artifact.bytes),'name')[0];
  assert(section,'The private qualification needs retained WASM function names.');
  const bytes=new Uint8Array(section);let cursor=0;
  function uint():number {let value=0,shift=0,byte;do{byte=bytes[cursor++]!;value|=(byte&127)<<shift;shift+=7;assert(shift<=35);}while(byte&128);return value>>>0;}
  const table=new Map<number,string>();
  while(cursor<bytes.length){const kind=bytes[cursor++]!,length=uint(),end=cursor+length;
    if(kind===1){const count=uint();for(let i=0;i<count;i++){const index=uint(),size=uint();table.set(index,new TextDecoder().decode(bytes.subarray(cursor,cursor+size)));cursor+=size;}}
    cursor=end;
  }
  names.set(artifact.manifest.id,table);
}
async function recover(point:string):Promise<void>{
  const digests=cores.map(core=>core.engine.digest()),frames=cores.map(core=>core.engine.frame),sizes=[];
  for(const [side,artifact] of [first,second].entries()){
    if(!baselines.has(artifact.manifest.id))baselines.set(artifact.manifest.id,await createCheckpointBaseline(await WebAssembly.compile(artifact.bytes)));
    const packed=gzipSync(encodeCheckpoint(cores[side]!.engine.snapshot(),baselines.get(artifact.manifest.id)!,artifact.manifest.wasmSha256));
    sizes.push(packed.length);await writeFile(resolve(directory,`${stem}-${point}-${side}.checkpoint.gz`),packed);
  }
  cores.forEach(core=>core.close());
  const replacement=[];
  for(const [side,artifact] of [first,second].entries()){
    const packed=gunzipSync(await readFile(resolve(directory,`${stem}-${point}-${side}.checkpoint.gz`)));
    replacement.push(await OriginalBattleCore.restore(artifact.bytes,artifact.manifest,2301,
      decodeCheckpoint(new Uint8Array(packed),baselines.get(artifact.manifest.id)!,artifact.manifest.wasmSha256)));
  }
  cores=replacement;assert.deepEqual(cores.map(core=>core.engine.digest()),digests);
  assert.deepEqual(cores.map(core=>core.engine.frame),frames);recoveries.push({point,frames,bytes:sizes});
}
function partyMenuVisible(core:OriginalBattleCore):boolean{
  const c=core.engine.bindExtension<{memory:WebAssembly.Memory;gMain:WebAssembly.Global;__indirect_function_table:WebAssembly.Table}>(
    'kanto_battle_abi_version',1,[]);
  const callback=new DataView(c.memory.buffer).getUint32(Number(c.gMain.value)+4,true);
  const raw=c.__indirect_function_table.get(callback)?.name??'';
  const name=names.get(core.engine.manifest.id)!.get(Number(raw))??raw;
  return name.includes('CB2_UpdatePartyMenu');
}
function immutable(core:OriginalBattleCore):string{
  const c=core.engine.bindExtension<{memory:WebAssembly.Memory;kanto_immutable_ptr():number;kanto_immutable_size():number}>(
    'kanto_battle_abi_version',1,['kanto_immutable_ptr','kanto_immutable_size']);
  return createHash('sha256').update(new Uint8Array(c.memory.buffer,c.kanto_immutable_ptr(),c.kanto_immutable_size())).digest('hex');
}
const immutableBefore=cores.map(immutable);
const limit=Number(process.env.KANTO_BATTLE_FRAMES??30000);
const debug=()=>cores.map(core=>({frame:core.engine.frame,phase:core.phase,flags:core.read(2).toString(16),exec:core.read(3).toString(16),
  outcome:core.read(1),commands:[core.read(5,0),core.read(5,1)],species:[core.read(6,0),core.read(6,1)],hp:[core.read(7,0),core.read(7,1)]}));
function pump(hash:ReturnType<typeof createHash>):number{
  if(!transportBoundsChecked)for(const source of cores){const packet=source.outgoing();if(!packet)continue;
    if(!transportBoundsChecked){
      const malformed=packet.slice();new DataView(malformed.buffer).setUint32(4,257,true);
      assert.throws(()=>cores[0]!.deliver(malformed),{code:'INVALID_BATTLE_PACKET'});
      const outOfOrder=packet.slice();const view=new DataView(outOfOrder.buffer);
      view.setUint32(8,view.getUint32(8,true)+1,true);
      assert.throws(()=>cores[0]!.deliver(outOfOrder),{code:'INVALID_BATTLE_PACKET'});
      assert.throws(()=>source.acknowledge(outOfOrder),{code:'BATTLE_PACKET_CHANGED'});
      assert.deepEqual(source.outgoing(),packet);
      assert(cores[0]!.deliver(packet));assert(cores[0]!.deliver(packet),'Transport retransmission was not idempotent.');
      transportBoundsChecked=true;
    }
    break;
  }
  return transferBattleBlocks(cores,packet=>{hash.update(packet);});
}
async function capture(frame:number):Promise<void>{
  for(let side=0;side<2;side++){
    const pixels=cores[side]!.screen();assert.equal(pixels.buffer.byteLength,240*160*4);
    await writeFile(resolve(directory,`battle-${second.manifest.version}-${partyFixture??'adventure'}-${side}-${frame}.rgba`),
      pixels);
  }
}
try{
  for(let frame=0;frame<limit;frame++){
    blocks+=pump(packetHash);
    const step:[number,number]=[0,0];
    for(let side=0;side<2;side++){
      const core=cores[side]!;if(core.phase!==2)continue;
      let buttons=frame%31===0?1:0;
      if(core.read(5,side)===choosePokemon){
        forcedSwitchObserved=true;
        const slot=core.read(13);
        if(frame%31===0 && (slot>=core.read(14) || !core.read(15,slot)))buttons=128;
      }
      step[side as 0|1]=buttons;
      core.engine.advance([{buttons,frames:1}]);
    }
    inputs.push(step);
    if(!masterIntro&&cores[0]!.read(6,0)>0&&cores[0]!.read(6,1)>0){
      masterIntro=true;
      assert.deepEqual([cores[0]!.read(8,0),cores[0]!.read(8,1)],sourceParties.map(party=>party.find(mon=>!mon.isEgg)!.level),
        'A link battle changed an earned level.');
      assert(cores.every(core=>core.read(16)===terrain),'A link battle inherited an adventure terrain instead of the original Colosseum.');
    }
    if(masterIntro){const hp=[cores[0]!.read(7,0),cores[0]!.read(7,1)];initialHp??=hp;
      if(hp.some((value,i)=>value<initialHp![i]!))damageObserved=true;}
    if(frame%1000===0){const state=debug();events.push(state);console.log(JSON.stringify({battleFrame:frame,blocks,state}));}
    if(frame===1000||frame===6000)await capture(frame);
    if(frame===1100){
      await recover('intro');recovered=true;
    }
    if(forcedSwitchObserved&&!recoveredInSwitch&&cores.some(partyMenuVisible)){
      await recover('switch-menu');recoveredInSwitch=true;
    }
    if(cores.every(core=>core.phase===3))break;
  }
  console.log(JSON.stringify({final:debug(),blocks,masterIntro,damageObserved,forcedSwitchObserved}));
  assert(masterIntro,'Original link battle did not initialize both battlers.');
  assert(cores.every(core=>core.phase===3),'Original link battle did not finish.');
  assert(cores.every(core=>[1,2,3,9].includes(core.read(1))),'Original battle outcome is missing.');
  assert(damageObserved,'The original master never applied battle damage.');
  assert.deepEqual(cores.map(core=>core.read(1)).sort(),[1,2],'The two consoles did not report opposite outcomes.');
  if(partyFixture==='ordinary'){
    assert(forcedSwitchObserved,'The two-member parties never reached an original forced switch.');
    assert(recoveredInSwitch,'The original forced-switch menu was not recovered.');
  }
  assert.deepEqual(cores[0]!.engine.flash(),saveA);assert.deepEqual(cores[1]!.engine.flash(),saveB);
  assert.deepEqual(cores.map(immutable),immutableBefore,'The battle changed immutable source assets.');
  const final=debug(),digests=cores.map(core=>core.engine.digest()),packets=packetHash.digest('hex');
  cores.forEach(core=>core.close());
  // Independent fresh instances replay the exact captured player buttons,
  // deriving every transport block again from the original C endpoints.
  cores=[await OriginalBattleCore.create(first.bytes,first.manifest,2301,saveA,0),
    await OriginalBattleCore.create(second.bytes,second.manifest,2301,saveB,1)];
  const helloA=cores[0]!.hello(),helloB=cores[1]!.hello();cores[0]!.start(helloB);cores[1]!.start(helloA);
  const replayHash=createHash('sha256');let replayBlocks=0;
  for(const step of inputs){
    replayBlocks+=pump(replayHash);
    for(let side=0;side<2;side++)if(cores[side]!.phase===2)cores[side]!.engine.advance([{buttons:step[side]!,frames:1}]);
  }
  assert.equal(replayBlocks,blocks);assert.equal(replayHash.digest('hex'),packets,'Original controller blocks changed on input replay.');
  assert.deepEqual(cores.map(core=>core.engine.digest()),digests,'The original two-console battle diverged on replay.');
  assert.deepEqual(cores.map(immutable),immutableBefore);
  const linearMemoryBytes=cores.map(core=>core.engine.bindExtension<{memory:WebAssembly.Memory}>('kanto_battle_abi_version',1,[]).memory.buffer.byteLength);
  const reportName=`${stem}-report.json`;
  await writeFile(resolve(directory,reportName),JSON.stringify({artifacts:[first.manifest.id,second.manifest.id],
    originalC:true,physicalTransportReplaced:true,blocks,packetSha256:packets,recovered,masterIntro,damageObserved,forcedSwitchObserved,sourceCartridgesUnchanged:true,
    deterministicReplay:true,transportBoundsChecked,originalColosseumTerrain:true,immutableAssetsUnchanged:true,earnedLevelsUnchanged:true,linearMemoryBytes,
    packedCheckpointRecovery:true,recoveredInSwitch,recoveries,
    finalDigests:digests,final,events,testInputPolicy:true,completePvpQualified:false,publicReleaseQualified:false},null,2)+'\n');
  await writeFile(resolve(directory,reportName.replace('-report.json','-inputs.json')),JSON.stringify({artifacts:[first.manifest.id,second.manifest.id],
    seed:2301,saveSha256:[saveA,saveB].map(bytes=>createHash('sha256').update(bytes).digest('hex')),testInputPolicy:true,inputs})+'\n');
}finally{cores.forEach(core=>core.close());}
