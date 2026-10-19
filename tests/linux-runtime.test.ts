import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessLinuxRuntime,type RuntimeObservation} from '../infra/inspect-linux-runtime.ts';

const observed:RuntimeObservation={platform:'linux',status:'Uid:\t1000\t1000\t1000\t1000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nNoNewPrivs:\t1\n',
  mountinfo:'1 2 0:1 / / ro,relatime - overlay overlay rw\n',memoryMax:'4294967296\n',swapMax:'0\n',cpuMax:'200000 100000\n',pidsMax:'192\n'};
test('staging runtime observation distinguishes bounded container settings from host defaults',()=>{
  assert.equal(assessLinuxRuntime(observed).configurationMatches,true);
  const variants:Partial<RuntimeObservation>[]=[{platform:'darwin'},{memoryMax:'max'},{swapMax:'max'},
    {cpuMax:'max 100000'},{cpuMax:'0 0'},{cpuMax:'400000 100000'},{pidsMax:'max'},
    {mountinfo:observed.mountinfo.replace('ro,relatime','rw,relatime')},
    {status:observed.status.replaceAll('1000','0')},{status:observed.status.replace('NoNewPrivs:\t1','NoNewPrivs:\t0')},
    {status:observed.status.replace('CapBnd:\t0000000000000000','CapBnd:\t00000000a80425fb')}];
  for(const variant of variants)assert.equal(assessLinuxRuntime({...observed,...variant}).configurationMatches,false,JSON.stringify(variant));
  assert.equal(assessLinuxRuntime(observed).kernelLimitEnforcementTested,false);
});

test('gateway runtime observation requires its own bounds and rejects the API profile',()=>{
  const gateway={...observed,memoryMax:'536870912',cpuMax:'100000 100000',pidsMax:'64'};
  assert.equal(assessLinuxRuntime(gateway,'gateway').configurationMatches,true);
  assert.equal(assessLinuxRuntime(observed,'gateway').configurationMatches,false);
  assert.equal(assessLinuxRuntime(gateway,'api').configurationMatches,false);
  for(const variant of [{memoryMax:'max'},{swapMax:'max'},{cpuMax:'max 100000'},{pidsMax:'max'}])
    assert.equal(assessLinuxRuntime({...gateway,...variant},'gateway').configurationMatches,false);
});
