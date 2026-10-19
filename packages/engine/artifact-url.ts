import type {GameVersion} from '../protocol/index.ts';

/** Only immutable game bytes use this URL. Player checkpoints stay private. */
export function gameArtifactUrl(version:GameVersion,sha256:string):string{
  return `/api/engines/${version}/${sha256}.wasm`;
}
