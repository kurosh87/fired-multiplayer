import {privateWorkerPort} from '../engine/private-worker-transport.ts';
import {createHash,type Hash} from 'node:crypto';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {OriginalBattlePair,type BattleArtifact} from './original-pair.ts';
import {createCheckpointBaseline,encodeCheckpoint,decodeCheckpoint,maxCheckpointBytes} from '../engine/checkpoint.ts';
import {DomainError} from '../protocol/index.ts';

const port=privateWorkerPort(),compress=promisify(gzip),decompress=promisify(gunzip);
const artifacts=new Map<string,{artifact:Omit<BattleArtifact,'seed'>;baseline:Uint8Array}>();
let pair:OriginalBattlePair|undefined,active:[BattleArtifact,BattleArtifact]|undefined;
let transport:Hash=createHash('sha256');
const metadata=()=>({frame:pair!.frame,result:pair!.result()??null});
function requirePair():OriginalBattlePair{
  if(!pair)throw new DomainError('BATTLE_WORKER_EMPTY','Restore the original consoles before sending controls.',503);return pair;
}
async function handle(message:any):Promise<{data:unknown;transfer?:ArrayBuffer[]}>{
  switch(message.operation){
    case 'install':{
      const artifact=message.artifact as Omit<BattleArtifact,'seed'>,key=artifact.manifest.wasmSha256;
      if(artifacts.has(key))return {data:null};
      if(artifacts.size>=4)throw new DomainError('ENGINE_ARTIFACT_LIMIT','This worker has reached its artifact cache limit.',503);
      if(createHash('sha256').update(artifact.bytes).digest('hex')!==key)
        throw new DomainError('ENGINE_HASH_MISMATCH','The private battle artifact failed validation.',503);
      const baseline=await createCheckpointBaseline(await WebAssembly.compile(Uint8Array.from(artifact.bytes)));
      if(baseline.byteLength>64*1024*1024)throw new DomainError('ENGINE_MEMORY_LIMIT','This battle artifact exceeds its worker memory limit.',503);
      artifacts.set(key,{artifact,baseline});return {data:null};
    }
    case 'create':case 'restore':{
      if(pair)throw new DomainError('BATTLE_WORKER_BUSY','This worker already owns original consoles.',503);
      active=message.artifacts.map((entry:{hash:string;seed:number})=>{
        const item=artifacts.get(entry.hash);if(!item)throw new DomainError('ENGINE_UNAVAILABLE','The pinned battle artifact is not installed.',503);
        return {...item.artifact,seed:entry.seed};
      });
      if(!active||active.length!==2)throw new Error('Two pinned artifacts are required.');
      if(message.operation==='create')pair=await OriginalBattlePair.create(active,message.saves);
      else{
        const memories=await Promise.all(message.points.map(async(point:Uint8Array,side:number)=>{
          const artifact=active![side]!,baseline=artifacts.get(artifact.manifest.wasmSha256)!.baseline;
          return decodeCheckpoint(await decompress(point,{maxOutputLength:maxCheckpointBytes(baseline.byteLength)}),baseline,
            artifact.manifest.wasmSha256,{allowLegacy:true});
        }));
        pair=await OriginalBattlePair.restore(active,{protocol:1,frame:message.frame,
          artifacts:active.map(artifact=>artifact.manifest.id) as [string,string],memories:memories as [Uint8Array,Uint8Array]});
      }
      transport=createHash('sha256');return {data:metadata()};
    }
    case 'advance':{
      if(message.signalStarted)port.postMessage({id:message.id,running:true});
      const core=requirePair(),decisions=[];
      if(!Number.isInteger(message.frames)||message.frames<1||message.frames>60)throw new Error('Invalid private frame batch.');
      for(let frame=0;frame<message.frames&&!core.done;frame++){
        core.tick(message.buttons,(packet)=>{transport.update(packet);});decisions.push(core.decision());
      }
      return {data:{...metadata(),decisions}};
    }
    case 'progress':{
      const digests=requirePair().digests(),transportDigest=transport.digest('hex');transport=createHash('sha256');
      return {data:{digests,transportDigest}};
    }
    case 'checkpoint':{
      const snapshot=requirePair().snapshot();
      const points=await Promise.all(snapshot.memories.map(async(memory,side)=>{
        const artifact=active![side]!,baseline=artifacts.get(artifact.manifest.wasmSha256)!.baseline;
        return Uint8Array.from(await compress(encodeCheckpoint(memory,baseline,artifact.manifest.wasmSha256),{level:1}));
      }));
      return {data:points,transfer:points.map(point=>point.buffer)};
    }
    case 'screens':{
      const core=requirePair(),screens=message.sides.map((side:'a'|'b')=>core.screen(side)) as Uint8Array<ArrayBuffer>[];
      return {data:screens,transfer:screens.map(screen=>screen.buffer)};
    }
    case 'metrics':return {data:{pid:process.pid,transport:port.kind,processCpu:process.cpuUsage(),threadCpu:typeof process.threadCpuUsage==='function'?process.threadCpuUsage():null,
      memory:process.memoryUsage(),environmentKeys:Object.keys(process.env).sort()}};
    case 'close':pair?.close();pair=undefined;active=undefined;transport=createHash('sha256');return {data:null};
    default:throw new Error('Unsupported private worker operation.');
  }
}
// Compression is asynchronous: keep commands ordered until the entire prior
// request finishes, including checkpoint copying and buffer transfers.
let tail=Promise.resolve();
port.on('message',message=>{
  tail=tail.then(async()=>{
    try{
      const result=await handle(message);port.postMessage({id:message.id,ok:true,data:result.data},result.transfer??[]);
    }catch(error){port.postMessage({id:message.id,ok:false,error:{code:error instanceof DomainError?error.code:'BATTLE_WORKER_FAILED',
      message:error instanceof DomainError?error.message:'Restore the original consoles from verified progress.',status:error instanceof DomainError?error.status:503}});}
  });
});
