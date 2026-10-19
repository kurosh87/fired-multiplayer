import {EngineRegistry} from '../packages/engine/registry.ts';
import {DomainError} from '../packages/protocol/index.ts';
import {fixtureArtifact} from './fixture-engine.ts';

/** Arithmetic fixture only, never a published game provider. */
export function artifactCacheFixture(){
  const fixture=fixtureArtifact(),registry=new EngineRegistry();
  // A view into a larger allocation catches accidental prefix/suffix leaks
  // when the server shares the underlying buffer for its response.
  const allocation=new Uint8Array(fixture.bytes.byteLength+37).fill(0xab);
  allocation.set(fixture.bytes,13);const bytes=allocation.subarray(13,13+fixture.bytes.byteLength);
  registry.manifest=version=>{
    if(version!=='firered')throw new DomainError('ENGINE_UNAVAILABLE','Fixture unavailable.',503);
    return fixture.manifest;
  };
  registry.artifact=version=>{registry.manifest(version);return bytes;};
  return {...fixture,bytes,registry};
}
