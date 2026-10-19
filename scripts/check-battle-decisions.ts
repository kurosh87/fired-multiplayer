import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {OriginalBattlePair,type BattleArtifact} from '../packages/battles/original-pair.ts';
import {createCheckpointBaseline,decodeCheckpoint} from '../packages/engine/checkpoint.ts';
import type {GameVersion} from '../packages/protocol/index.ts';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const guard=join(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)
  throw new Error('Run this finite qualification through scripts/run-local.py or the shared build guard.');
const artifacts=new Map<GameVersion,{artifact:BattleArtifact;baseline:Uint8Array}>();
for(const version of ['firered','leafgreen'] as const){
  const directory=`build/game-source/${version}/battle`,bytes=new Uint8Array(await readFile(`${directory}/candidate.wasm`));
  artifacts.set(version,{artifact:{bytes,manifest:JSON.parse(await readFile(`${directory}/candidate.json`,'utf8')),seed:2301},
    baseline:await createCheckpointBaseline(await WebAssembly.compile(bytes))});
}
const cases=[];
for(const versions of [['firered','firered'],['leafgreen','leafgreen'],['firered','leafgreen']] as [GameVersion,GameVersion][]){
  const directory=`build/game-source/${versions[0]}/battle`,stem=`battle${versions[0]===versions[1]?'':'-'+versions[1]}-ordinary`;
  const report=JSON.parse(await readFile(`${directory}/${stem}-report.json`,'utf8'));
  const pairArtifacts=versions.map(version=>artifacts.get(version)!.artifact) as [BattleArtifact,BattleArtifact];
  assert.deepEqual(report.artifacts,pairArtifacts.map(artifact=>artifact.manifest.id));
  const point=report.recoveries.find((entry:{point:string})=>entry.point==='switch-menu');assert(point);
  const memories=await Promise.all(versions.map(async(version,side)=>{
    const entry=artifacts.get(version)!;
    return decodeCheckpoint(new Uint8Array(gunzipSync(await readFile(`${directory}/${stem}-switch-menu-${side}.checkpoint.gz`))),
      entry.baseline,entry.artifact.manifest.wasmSha256);
  }));
  const pair=await OriginalBattlePair.restore(pairArtifacts,{protocol:1,frame:Math.max(...point.frames),artifacts:report.artifacts,
    memories:memories as [Uint8Array,Uint8Array]});
  try{
    const before=pair.digests(),decision=pair.decision();
    assert.equal(decision.kind,'switch');assert([1,2].includes(decision.mask),'A forced replacement must wait only for the required player.');
    for(let read=0;read<100;read++)assert.deepEqual(pair.decision(),decision);
    assert.deepEqual(pair.digests(),before,'Reading a choice request mutated original game state.');
    cases.push({artifacts:report.artifacts,frame:pair.frame,decision,originalVisiblePartyMenu:true,readOnly:true});
  }finally{pair.close();}
}
await writeFile('build/battle-decision-report.json',JSON.stringify({cases,publicReleaseQualified:false},null,2)+'\n');
