import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {WasmEngine} from '../packages/engine/runtime.ts';
import {createCheckpointBaseline,encodeCheckpoint} from '../packages/engine/checkpoint.ts';

const guard=resolve(process.env.HOME??'','.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use scripts/run-local.py.');
const [version,tag]=process.argv.slice(2);assert(version&&['firered','leafgreen'].includes(version));assert(tag&&/^[a-z0-9-]{1,40}$/.test(tag));
const folder=resolve(`build/adventure-qualification/${tag}`),game=resolve(`build/game-source/${version}/audio-16`);
const load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const report=await load(folder+'/report.json'),movie=await load(folder+'/replay.json'),base=await load(`tests/replays/${version}-audio-pc-storage.json`);
assert(report.pureInputReplay&&report.freshContinue&&report.warmResetContinue&&report.completeCheckpointRestore);
assert.equal(report.sourceHashes.qualifier,sha(await readFile('scripts/check-forest-adventure.ts')));
const manifest=await load(game+'/candidate.json'),bytes=new Uint8Array(await readFile(game+'/candidate.wasm'));
assert.equal(manifest.id,report.artifactId);assert.equal(sha(bytes),report.wasmSha256);assert.equal(movie.expectedDigest,report.digest);
assert.deepEqual(movie.runs.slice(0,base.runs.length),base.runs);
const runs=movie.runs.slice(base.runs.length);assert.equal(runs.reduce((n:number,r:{frames:number})=>n+r.frames,0),report.frames-base.expectedFrames);
const outputs=['browser-inputs.json','browser-start.checkpoint.gz','browser.sav','browser-preparation.json'];
for(const name of outputs)assert(!existsSync(folder+'/'+name),'Preserve prior browser fixture.');
const engine=await WasmEngine.create(bytes,manifest,base.seed);
try{
  const point=await readFile(game+'/route-audio-pc-desktop.checkpoint');engine.restore(new Uint8Array(point));
  assert.equal(engine.frame,base.expectedFrames);assert.equal(engine.digest(),base.expectedDigest);
  const baseline=await createCheckpointBaseline(await WebAssembly.compile(bytes));
  await writeFile(folder+'/browser-start.checkpoint.gz',gzipSync(encodeCheckpoint(engine.snapshot(),baseline,manifest.wasmSha256)));
  await writeFile(folder+'/browser.sav',await readFile(folder+'/adventure.sav'));
  await writeFile(folder+'/browser-inputs.json',JSON.stringify({seed:base.seed,sourceCommit:manifest.upstreamCommit,artifactId:manifest.id,
    startDigest:base.expectedDigest,startFrame:base.expectedFrames,expectedDigest:report.digest,expectedFrames:report.frames,runs,
    milestones:movie.milestones.filter((m:{frame:number})=>m.frame>base.expectedFrames)},null,2)+'\n');
  await writeFile(folder+'/browser-preparation.json',JSON.stringify({sourceSha256:sha(await readFile('scripts/prepare-forest-browser.ts')),
    qualifiedSourceCheckpointSha256:sha(point),startingFrame:engine.frame,startingDigest:engine.digest(),
    finalFrame:report.frames,newFrames:report.frames-engine.frame,scope:'Complete new continuation from the retained full-PC browser checkpoint. Fresh-boot full movie is verified separately by check-forest-adventure.'},null,2)+'\n');
  console.log(JSON.stringify({version,folder,startFrame:engine.frame,newFrames:report.frames-engine.frame}));
}finally{engine.close();}
