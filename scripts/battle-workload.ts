import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {WasmEngine,type EngineManifest} from '../packages/engine/runtime.ts';
import {createCheckpointBaseline,decodeCheckpoint} from '../packages/engine/checkpoint.ts';
import type {BattleArtifact} from '../packages/battles/original-pair.ts';

/** Exact recorded two-party cross-version match, tied to the independent C
 * qualification. Fixture Pokemon were created by original C, never a client. */
export async function battleWorkload():Promise<{artifacts:[BattleArtifact,BattleArtifact];saves:[Uint8Array,Uint8Array];
  inputs:[number,number][];report:any}>{
  const path='build/game-source/firered/battle/battle-leafgreen-ordinary';
  const report=JSON.parse(await readFile(`${path}-report.json`,'utf8')),movie=JSON.parse(await readFile(`${path}-inputs.json`,'utf8'));
  const artifacts:BattleArtifact[]=[],saves:Uint8Array[]=[];
  for(const [side,version] of ['firered','leafgreen'].entries()){
    const directory=`build/game-source/${version}`,bytes=new Uint8Array(await readFile(`${directory}/battle/candidate.wasm`));
    const manifest=JSON.parse(await readFile(`${directory}/battle/candidate.json`,'utf8')) as EngineManifest;
    assert.equal(manifest.id,report.artifacts[side]);assert.equal(manifest.id,movie.artifacts[side]);
    artifacts.push({bytes,manifest,seed:movie.seed});
    const base=new Uint8Array(await readFile(`${directory}/candidate.wasm`)),baseManifest=JSON.parse(await readFile(`${directory}/candidate.json`,'utf8')) as EngineManifest;
    const stem=`${directory}/exchange-checks/ordinary-${side===0?'a':'b'}`,meta=JSON.parse(await readFile(`${stem}-inputs.json`,'utf8'));
    assert.equal(meta.artifactId,baseManifest.id);
    const engine=await WasmEngine.create(base,baseManifest,meta.seed);
    try{
      engine.restore(decodeCheckpoint(new Uint8Array(gunzipSync(await readFile(`${stem}-start.checkpoint.gz`))),
        await createCheckpointBaseline(await WebAssembly.compile(base)),baseManifest.wasmSha256));saves.push(engine.flash());
    }finally{engine.close();}
  }
  assert(report.originalC&&report.deterministicReplay&&report.forcedSwitchObserved);
  assert.deepEqual(report.artifacts,movie.artifacts);
  return {artifacts:artifacts as [BattleArtifact,BattleArtifact],saves:saves as [Uint8Array,Uint8Array],inputs:movie.inputs,report};
}
