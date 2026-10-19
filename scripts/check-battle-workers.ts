import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {BattleConsolePool,type BattleConsole} from '../packages/battles/console-pool.ts';
import {OriginalBattlePair} from '../packages/battles/original-pair.ts';
import {battleWorkload} from './battle-workload.ts';

const guard=join(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)throw new Error('Use the shared build guard.');
const tag=process.env.KANTO_WORKER_EVIDENCE_TAG;if(tag)assert(/^[a-z0-9-]{1,32}$/.test(tag));
const output=`build/${tag?tag+'-':''}battle-worker-report.json`;if(tag)assert(!existsSync(output),'Preserve retained worker evidence.');
const workload=await battleWorkload(),pool=new BattleConsolePool(2);
let remote:BattleConsole|undefined,survivor:BattleConsole|undefined;
const inline=await OriginalBattlePair.create(workload.artifacts,workload.saves);
try{
  remote=await pool.create(workload.artifacts,workload.saves);survivor=await pool.create(workload.artifacts,workload.saves);
  await assert.rejects(pool.create(workload.artifacts,workload.saves),{code:'BATTLE_CAPACITY'});
  const survivorStart=await survivor.progress(),initial=await remote.progress();assert.deepEqual(initial.digests,inline.digests());
  const execution=await remote.metrics();
  assert(execution.environmentKeys.every(key=>key==='NODE_OPTIONS'),'A worker inherited application environment credentials.');
  assert.equal(execution.transport,process.env.GAME_WORKER_TRANSPORT??'thread');if(execution.transport==='process')assert.notEqual(execution.pid,process.pid);
  let hash=createHash('sha256'),recovered=false,screens=0;
  for(let frame=0;frame<workload.inputs.length;frame++){
    const buttons=workload.inputs[frame]!;inline.tick(buttons,packet=>{hash.update(packet);});
    assert.deepEqual(await remote.advance(buttons,1),[inline.decision()]);assert.equal(remote.frame,inline.frame);
    if((frame+1)%15===0||inline.done){
      const progress=await remote.progress();assert.deepEqual(progress.digests,inline.digests());
      assert.equal(progress.transportDigest,hash.digest('hex'));hash=createHash('sha256');
    }
    if([999,5999].includes(frame)){
      const views=await remote.screens(['a','b']);
      for(const [side,view] of views.entries()){
        assert.equal(view.byteLength,153600);assert.equal(view.buffer.byteLength,153600);assert.deepEqual(view,inline.screen(side===0?'a':'b'));screens++;
      }
    }
    if(!recovered&&frame===1109){
      const points=await remote.checkpoint(),failed=remote;
      let started!:()=>void;const running=new Promise<void>(resolve=>{started=resolve;});
      const inFlight=failed.advance([0,0],60,started),rejected=assert.rejects(inFlight,{code:'BATTLE_WORKER_LOST'});
      await running;await pool.terminate(failed);await rejected;
      await assert.rejects(failed.progress(),{code:'BATTLE_WORKER_LOST'});
      assert.deepEqual((await survivor.progress()).digests,survivorStart.digests,'A failed worker damaged another match.');
      await failed.close();remote=await pool.restore(workload.artifacts,inline.frame,points);
      assert.deepEqual((await remote.progress()).digests,inline.digests());recovered=true;
    }
  }
  assert(inline.done&&remote.done&&recovered);assert.equal(screens,4);
  const final=await remote.progress();assert.deepEqual(final.digests,workload.report.finalDigests);
  assert.deepEqual(remote.result(),inline.result());
  await remote.close();remote=await pool.create(workload.artifacts,workload.saves);
  assert.equal(remote.frame,0);assert.deepEqual((await remote.progress()).digests,initial.digests,'Reusing a worker retained an old match.');
  await writeFile(output,JSON.stringify({artifacts:workload.report.artifacts,transport:execution.transport,executionPid:execution.pid,workerEnvironmentStripped:true,
    originalC:true,recordedFrames:workload.inputs.length,progressDigestsAndTransportMatch:true,decisionRequestsMatch:true,
    separatePrivateScreensMatch:true,workerAdvanceStartedBeforeKill:true,workerKilledDuringAdvance:true,checkpointRecovery:true,otherWorkerUnaffected:true,
    capacityBoundEnforced:true,reusedWorkerResetsConsoles:true,sourceQualifiedFinalDigests:true,
    distributedWorkersQualified:false,capacity1000Qualified:false,publicReleaseQualified:false},null,2)+'\n');
}finally{inline.close();await remote?.close();await survivor?.close();await pool.close();}
