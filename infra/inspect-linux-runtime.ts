import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export type RuntimeObservation={platform:string;status:string;mountinfo:string;memoryMax:string;swapMax:string;cpuMax:string;pidsMax:string};

/** Observe the staging container's actual cgroup-v2 and process settings.
 * This checks configuration, not OOM behavior, workload capacity or gameplay. */
export function assessLinuxRuntime(value:RuntimeObservation,profile:'api'|'gateway'='api'){
  if(!['api','gateway'].includes(profile))throw new Error('Choose the api or gateway runtime profile.');
  const expected=profile==='gateway'?{memory:'536870912',cpus:1,pids:'64'}:{memory:'4294967296',cpus:2,pids:'192'};
  const fields=(name:string)=>value.status.match(new RegExp(`^${name}:\\s+(.+)$`,'m'))?.[1]?.trim();
  const uid=fields('Uid')?.split(/\s+/).map(Number)??[];
  const zero=(text:string|undefined)=>Boolean(text&&/^0+$/.test(text));
  const cpu=value.cpuMax.trim().split(/\s+/).map(Number);
  const root=value.mountinfo.split('\n').map(line=>line.split(' ')).find(parts=>parts[4]==='/');
  const checks={linux:value.platform==='linux',uid1000:uid.length===4&&uid.every(id=>id===1000),
    effectiveCapabilitiesEmpty:zero(fields('CapEff')),boundingCapabilitiesEmpty:zero(fields('CapBnd')),
    noNewPrivileges:fields('NoNewPrivs')==='1',rootFilesystemReadOnly:Boolean(root?.[5]?.split(',').includes('ro')),
    memoryLimit:value.memoryMax.trim()===expected.memory,swapDisabled:value.swapMax.trim()==='0',
    cpuLimit:Number.isFinite(cpu[0])&&Number.isFinite(cpu[1])&&cpu[1]!>0&&cpu[0]! / cpu[1]! === expected.cpus,
    pidLimit:value.pidsMax.trim()===expected.pids};
  return {profile,configurationMatches:Object.values(checks).every(Boolean),checks,
    observed:{uids:uid,memoryMax:value.memoryMax.trim(),swapMax:value.swapMax.trim(),cpuMax:value.cpuMax.trim(),pidsMax:value.pidsMax.trim()},
    kernelLimitEnforcementTested:false,workloadCapacityQualified:false,publicReleaseQualified:false};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{
    const profile=process.argv[2]??'api';
    if(!['api','gateway'].includes(profile)||process.argv.length>3)throw new Error('Choose one runtime profile.');
    const [status,mountinfo,memoryMax,swapMax,cpuMax,pidsMax]=await Promise.all([
      '/proc/self/status','/proc/self/mountinfo','/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory.swap.max',
      '/sys/fs/cgroup/cpu.max','/sys/fs/cgroup/pids.max'].map(path=>readFile(path,'utf8')));
    const result=assessLinuxRuntime({platform:process.platform,status:status!,mountinfo:mountinfo!,memoryMax:memoryMax!,swapMax:swapMax!,cpuMax:cpuMax!,pidsMax:pidsMax!},profile as 'api'|'gateway');
    process.stdout.write(JSON.stringify(result)+'\n');if(!result.configurationMatches)process.exitCode=1;
  }catch{process.stdout.write(JSON.stringify({configurationMatches:false,reason:'Requires the actual Linux cgroup-v2 staging container.',publicReleaseQualified:false})+'\n');process.exitCode=1;}
}
