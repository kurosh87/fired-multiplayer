import {readFile} from 'node:fs/promises';
import {EngineRegistry} from '../packages/engine/registry.ts';
import {createCheckpointBaseline,encodeCheckpoint,decodeCheckpoint,maxCheckpointBytes} from '../packages/engine/checkpoint.ts';
import type {EngineManifest} from '../packages/engine/runtime.ts';
import type {GameVersion} from '../packages/protocol/index.ts';

/** Explicit local qualification variant. Production artifact routing never
 * reads this setting, and game workers do not inherit it. */
export function originalGameDirectory(version:GameVersion,battle=false,audio=false,battleText=false):string{
  if(battleText){
    if(battle||!audio)throw new Error('Repaired battle text currently targets audio adventure/trade qualification.');
    return `build/game-source/${version}/battle-text-audio-16`;
  }
  if(audio){if(battle)throw new Error('The audio provider currently targets adventure/trade cores.');return `build/game-source/${version}/audio-16`;}
  const memory=process.env.KANTO_QUALIFICATION_MEMORY_MIB??'64';
  if(!['16','32','64'].includes(memory))throw new Error('KANTO_QUALIFICATION_MEMORY_MIB must be 16, 32 or 64.');
  return `build/game-source/${version}${battle?'/battle':memory==='64'?'':`/memory-${memory}`}`;
}

/** Test-only trusted provider: no manifest capabilities or public artifacts
 * are changed to admit experimental C to isolated qualifications. */
export async function originalGameProvider(battle=false,audio=false,battleText=false):Promise<EngineRegistry>{
  const artifacts=new Map<GameVersion,{bytes:Uint8Array;manifest:EngineManifest;baseline:Uint8Array}>();
  for(const version of ['firered','leafgreen'] as const){
    const path=originalGameDirectory(version,battle,audio,battleText),bytes=new Uint8Array(await readFile(`${path}/candidate.wasm`));
    artifacts.set(version,{bytes,manifest:JSON.parse(await readFile(`${path}/candidate.json`,'utf8')),
      baseline:await createCheckpointBaseline(await WebAssembly.compile(bytes))});
  }
  const registry=new EngineRegistry();
  registry.artifact=version=>artifacts.get(version)!.bytes;registry.manifest=version=>artifacts.get(version)!.manifest;
  registry.encodeCheckpoint=(version,memory)=>encodeCheckpoint(memory,artifacts.get(version)!.baseline,registry.manifest(version).wasmSha256);
  registry.decodeCheckpoint=(version,payload)=>decodeCheckpoint(payload,artifacts.get(version)!.baseline,registry.manifest(version).wasmSha256);
  registry.checkpointLimit=version=>maxCheckpointBytes(artifacts.get(version)!.baseline.byteLength);
  return registry;
}
