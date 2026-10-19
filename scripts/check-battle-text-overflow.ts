import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, decodeCheckpoint } from '../packages/engine/checkpoint.ts';
import type { InputRun } from '../packages/protocol/index.ts';

const guard=resolve(process.env.HOME??'', '.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)
  process.exit(spawnSync(guard,['--',process.execPath,'--experimental-strip-types',...process.argv.slice(1)],{stdio:'inherit'}).status??1);
const [version='firered',tag='v1']=process.argv.slice(2);
assert(['firered','leafgreen'].includes(version));assert(/^[a-z0-9-]{1,30}$/.test(tag));
const output=resolve(`build/${version}-battle-text-overflow-${tag}.json`);assert(!existsSync(output));
const directory=resolve(`build/game-source/${version}/audio-16`);
const manifest=JSON.parse(await readFile(resolve(directory,'candidate.json'),'utf8')) as EngineManifest;
const bytes=new Uint8Array(await readFile(resolve(directory,'candidate.wasm')));
const baseline=await createCheckpointBaseline(await WebAssembly.compile(bytes));
const reportPath=resolve(`build/adventure-exploration/${version}/brock-save-audio/report.json`);
const report=JSON.parse(await readFile(reportPath,'utf8'));
assert.equal(report.artifactId,manifest.id);
const engine=await WasmEngine.create(bytes,manifest,12345);
const checkpoint=new Uint8Array(gunzipSync(await readFile(report.source)));
engine.restore(decodeCheckpoint(checkpoint,baseline,manifest.wasmSha256,{allowLegacy:true}));
assert.equal(engine.digest(),report.start.digest);
const core=engine.bindExtension<any>('kanto_lobby_save_abi_version',1,[]),view=new DataView(core.memory.buffer);
const ptr=(name:string)=>core[name].value as number;
const u32=(address:number)=>view.getUint32(address,true);
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const immutable=()=>sha(new Uint8Array(core.memory.buffer,core.kanto_immutable_ptr(),core.kanto_immutable_size()));
const originalImmutable=immutable(),transitions:unknown[]=[];
let flags=u32(ptr('gBattleTypeFlags')),firstOverflow:any;
for(const run of report.runs as InputRun[])for(let frame=0;frame<run.frames;frame++){
  engine.advance([{buttons:run.buttons,frames:1}]);
  const current=u32(ptr('gBattleTypeFlags'));
  if(current!==flags){
    const before=engine.digest(),text=ptr('gDisplayedStringBattle'),offset=ptr('gBattleTypeFlags')-text;
    const bytes=new Uint8Array(core.memory.buffer,text,512).slice();
    const transition={frame:engine.frame,previous:flags,current,textToFlagsOffset:offset,
      displayedBytes:Buffer.from(bytes).toString('hex')};
    transitions.push(transition);
    if(current>0xffff&&!firstOverflow)firstOverflow=transition;
    assert.equal(engine.digest(),before,'Diagnostic inspection must not alter game state.');flags=current;
  }
}
assert(firstOverflow,'The retained failing replay must reproduce the text overwrite.');
assert.equal(engine.digest(),report.end.digest,'Per-frame replay must match the recorded button movie.');
assert.equal(immutable(),originalImmutable);
const textBytes=Buffer.from(firstOverflow.displayedBytes,'hex');
assert.equal(textBytes.readUInt32LE(firstOverflow.textToFlagsOffset),firstOverflow.current);
await writeFile(output,JSON.stringify({artifactId:manifest.id,wasmSha256:manifest.wasmSha256,
  sourceReport:reportPath,sourceReportSha256:sha(new Uint8Array(await readFile(reportPath))),
  frameCount:report.frameCount,transitions,firstOverflow,
  originalBufferBytes:300,immutableDataUnchanged:true,inspectionMutatesCanonicalState:false,
  endDigest:engine.digest(),reproduced:true},null,2)+'\n');
engine.close();console.log(JSON.stringify({output,frame:firstOverflow.frame,flags:firstOverflow.current,offset:firstOverflow.textToFlagsOffset}));
