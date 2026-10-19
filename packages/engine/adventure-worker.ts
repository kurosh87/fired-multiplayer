import {privateWorkerPort} from './private-worker-transport.ts';
import {createHash} from 'node:crypto';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {WasmEngine,type EngineManifest} from './runtime.ts';
import {createCheckpointBaseline,encodeCheckpoint,decodeCheckpoint,maxCheckpointBytes} from './checkpoint.ts';
import {DomainError} from '../protocol/index.ts';
import {prepareLobbySave,inspectLobbyParty} from '../trading/prepare-lobby.ts';
import {OriginalTradeCore} from '../trading/original-core.ts';
import {pokemonDigest} from '../trading/atomic-trade.ts';

const port=privateWorkerPort(),compress=promisify(gzip),decompress=promisify(gunzip);
const artifacts=new Map<string,{bytes:Uint8Array;manifest:EngineManifest;baseline:Uint8Array}>();
let engine:WasmEngine|undefined,trade:OriginalTradeCore|undefined,active:ReturnType<typeof artifacts.get>,seed=0;
function current():WasmEngine{const core=trade?.engine??engine;if(!core)throw new DomainError('ADVENTURE_WORKER_EMPTY','Restore verified progress first.',503);return core;}
const metadata=()=>({frame:current().frame,digest:current().digest(),...(trade?{phase:trade.phase,
  ...(trade.phase===3?{resultFlash:current().flash()}: {})}:{})});
async function packed(snapshot:Uint8Array,artifact=active!):Promise<Uint8Array<ArrayBuffer>>{
  return Uint8Array.from(await compress(encodeCheckpoint(snapshot,artifact.baseline,artifact.manifest.wasmSha256),{level:1}));
}
async function handle(message:any):Promise<{data:unknown;transfer?:ArrayBuffer[]}>{
  switch(message.operation){
    case 'install':{
      const artifact=message.artifact as {bytes:Uint8Array;manifest:EngineManifest},key=artifact.manifest.wasmSha256;
      if(artifacts.has(key))return {data:null};
      if(artifacts.size>=4)throw new DomainError('ENGINE_ARTIFACT_LIMIT','This worker reached its artifact cache limit.',503);
      if(createHash('sha256').update(artifact.bytes).digest('hex')!==key)throw new DomainError('ENGINE_HASH_MISMATCH','The game artifact failed validation.',503);
      const baseline=await createCheckpointBaseline(await WebAssembly.compile(Uint8Array.from(artifact.bytes)));
      if(baseline.byteLength>64*1024*1024)throw new DomainError('ENGINE_MEMORY_LIMIT','This game exceeds its worker memory admission limit.',503);
      artifacts.set(key,{...artifact,baseline});return {data:null};
    }
    case 'create':{
      if(engine||trade)throw new DomainError('ADVENTURE_WORKER_BUSY','The worker already owns a game.',503);
      active=artifacts.get(message.hash);if(!active)throw new DomainError('ENGINE_UNAVAILABLE','The pinned game artifact is unavailable.',503);
      seed=message.seed;engine=await WasmEngine.create(active.bytes,active.manifest,seed,message.flash);
      if(message.checkpoint){
        engine.restore(decodeCheckpoint(await decompress(message.checkpoint,{maxOutputLength:maxCheckpointBytes(active.baseline.byteLength)}),
          active.baseline,active.manifest.wasmSha256,{allowLegacy:true}));
      }
      return {data:metadata()};
    }
    case 'advance':{
      if(message.signalStarted)port.postMessage({id:message.id,running:true});
      if(trade&&trade.phase!==2)throw new DomainError('TRADE_SCENE_DONE','This original scene has finished.',409);
      current().advance(message.runs);return {data:metadata()};
    }
    case 'capture':{
      const core=current(),snapshot=core.snapshot(),flash=Uint8Array.from(core.flash());
      if(message.raw)return {data:{...metadata(),snapshot,flash},transfer:[snapshot.buffer,flash.buffer]};
      const checkpoint=await packed(snapshot);return {data:{...metadata(),checkpoint,flash},transfer:[checkpoint.buffer,flash.buffer]};
    }
    case 'lobby':{
      const core=current(),staged=await prepareLobbySave(active!.bytes,active!.manifest,seed,core.snapshot());
      const checkpoint=await packed(staged.snapshot),flash=Uint8Array.from(staged.flash);
      return {data:{frame:staged.frame,digest:staged.digest,checkpoint,flash,party:staged.party},transfer:[checkpoint.buffer,flash.buffer]};
    }
    case 'inspect':{
      const artifact=artifacts.get(message.hash);if(!artifact)throw new Error('Missing pinned inspection artifact.');
      return {data:await inspectLobbyParty(artifact.bytes,artifact.manifest,message.seed,message.flash)};
    }
    case 'tradePrepare':case 'tradeChecks':{
      const cores:OriginalTradeCore[]=[],selected=message.artifacts.map((item:{hash:string})=>artifacts.get(item.hash));
      try{
        for(let side=0;side<2;side++){
          const artifact=selected[side];if(!artifact)throw new Error('Missing pinned trade artifact.');
          cores.push(await OriginalTradeCore.create(artifact.bytes,artifact.manifest,message.seeds?.[side]??0,message.saves[side]));
        }
        if(message.operation==='tradePrepare'&&cores.some((core,side)=>pokemonDigest(core.monBytes(message.slots[side]))!==message.digests[side]))
          throw new DomainError('POKEMON_CHANGED','Review the current parties before trading.',409);
        const a=cores[0]!,b=cores[1]!,packetA=a.packet(),packetB=b.packet();a.receive(packetB);b.receive(packetA);
        const checks={a:a.eligibility(message.slots[0],message.slots[1]),b:b.eligibility(message.slots[1],message.slots[0])};
        if(message.operation==='tradeChecks')return {data:checks};
        if(checks.a||checks.b)throw new DomainError('TRADE_NOT_ALLOWED','The original game rejected this trade.',409);
        a.start(message.slots[0],message.slots[1]);b.start(message.slots[1],message.slots[0]);
        const points=await Promise.all(cores.map((core,side)=>packed(core.engine.snapshot(),selected[side]!)));
        return {data:points,transfer:points.map(point=>point.buffer)};
      }finally{cores.forEach(core=>core.close());}
    }
    case 'tradeRestore':{
      if(engine||trade)throw new DomainError('TRADE_WORKER_BUSY','This worker already owns a game.',503);
      active=artifacts.get(message.hash);if(!active)throw new Error('Missing pinned trade artifact.');seed=message.seed;
      const snapshot=decodeCheckpoint(await decompress(message.checkpoint,{maxOutputLength:maxCheckpointBytes(active.baseline.byteLength)}),
        active.baseline,active.manifest.wasmSha256,{allowLegacy:true});
      trade=await OriginalTradeCore.restore(active.bytes,active.manifest,seed,snapshot);return {data:metadata()};
    }
    case 'metrics':return {data:{pid:process.pid,transport:port.kind,processCpu:process.cpuUsage(),threadCpu:typeof process.threadCpuUsage==='function'?process.threadCpuUsage():null,
      memory:process.memoryUsage(),environmentKeys:Object.keys(process.env).sort()}};
    case 'close':engine?.close();trade?.close();engine=undefined;trade=undefined;active=undefined;return {data:null};
    default:throw new Error('Unsupported private adventure operation.');
  }
}
let tail=Promise.resolve();
port.on('message',message=>{
  tail=tail.then(async()=>{
    try{const result=await handle(message);port.postMessage({id:message.id,ok:true,data:result.data},result.transfer??[]);}
    catch(error){port.postMessage({id:message.id,ok:false,error:{code:error instanceof DomainError?error.code:'ADVENTURE_WORKER_FAILED',
      message:error instanceof DomainError?error.message:'Restore your adventure from verified inputs.',status:error instanceof DomainError?error.status:503}});}
  });
});
