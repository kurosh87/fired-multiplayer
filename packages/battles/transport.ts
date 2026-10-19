import {DomainError} from '../protocol/index.ts';
import type {OriginalBattleCore} from './original-core.ts';

/** Route original server-owned blocks, including their original self echo.
 * A sender advances only after both recipients accept its current serial.
 * A blocked recipient leaves the source block pending for an idempotent retry.
 * These blocks contain private battle data and must never reach a browser. */
export function transferBattleBlocks(cores:readonly OriginalBattleCore[],onAcknowledged?:(packet:Uint8Array)=>void):number {
  if(cores.length!==2)throw new DomainError('INVALID_BATTLE','A singles link battle requires two original consoles.',503);
  let transferred=0;
  for(const [player,source] of cores.entries()){
    const packet=source.outgoing();if(!packet)continue;
    if(packet.byteLength!==268)throw new DomainError('ENGINE_ABI_ERROR','The original console exported an invalid block.',503);
    const header=new DataView(packet.buffer,packet.byteOffset,packet.byteLength),size=header.getUint32(4,true);
    if(header.getUint32(0,true)!==player||size<1||size>256||header.getUint32(8,true)===0)
      throw new DomainError('ENGINE_ABI_ERROR','An original block has invalid source identity or bounds.',503);
    // Both endpoints must be visited even if the first reports backpressure.
    const accepted=cores.map(target=>target.deliver(packet));
    if(accepted.every(Boolean)){source.acknowledge(packet);transferred++;onAcknowledged?.(packet);}
  }
  return transferred;
}
