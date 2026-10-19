import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {PRIVATE_BATTLE_PINS} from '../packages/battles/private-artifacts.ts';

/** Build into a fresh, private directory. Its caller owns the shared guard
 * and keeps prior bundles; this helper never deletes or replaces evidence. */
export async function buildNetlifyBattleRuntime(directory:string){
  assert(!existsSync(directory),'Preserve the previous private runtime bundle.');
  await mkdir(directory,{recursive:true,mode:0o700});
  const hashes:Record<string,string>={};
  for(const version of ['firered','leafgreen'] as const){
    const source=`build/game-source/${version}/battle/candidate`,bytes=await readFile(source+'.wasm');
    const manifest=JSON.parse(await readFile(source+'.json','utf8'));
    const hash=createHash('sha256').update(bytes).digest('hex'),pin=PRIVATE_BATTLE_PINS[version];
    assert.equal(manifest.id,pin.id);assert.equal(manifest.wasmSha256,pin.wasmSha256);
    assert.equal(manifest.upstreamCommit,pin.upstreamCommit);assert.equal(hash,pin.wasmSha256);
    assert.equal(manifest.version,version);assert.equal(manifest.revision,1);assert.equal(manifest.abi,1);
    // Keep the actual manifest, including its unqualified public capabilities.
    await writeFile(resolve(directory,version+'.wasm'),bytes,{mode:0o600});
    await writeFile(resolve(directory,version+'.json'),await readFile(source+'.json'),{mode:0o600});
    hashes[version+'.wasm']=hash;
  }
  await build({entryPoints:['packages/battles/console-worker.ts'],outfile:resolve(directory,'battle-worker.mjs'),
    bundle:true,platform:'node',target:'node24',format:'esm',sourcemap:false});
  for(const file of ['battle-worker.mjs','firered.json','leafgreen.json'])
    hashes[file]=createHash('sha256').update(await readFile(resolve(directory,file))).digest('hex');
  await writeFile(resolve(directory,'bundle.json'),JSON.stringify({pins:PRIVATE_BATTLE_PINS,hashes,publicReleaseQualified:false},null,2)+'\n',{mode:0o600});
  return hashes;
}
