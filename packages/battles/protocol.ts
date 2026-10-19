import {assertRecord,BUTTON_MASK,DomainError} from '../protocol/index.ts';
import type {GameVersion} from '../protocol/index.ts';
import type {BattleResult,Side} from './session.ts';

export type BattleView={id:string;side:Side;status:'offered'|'starting'|'active'|'finished'|'cancelled'|'expired';
  playerA:{id:string;handle:string;version:GameVersion};playerB:{id:string;handle:string;version:GameVersion};
  rules:{format:'singles';levels:'earned';ranked:false};expiresAt:number;result:BattleResult|null};
/** Public projection of a running battle for the lobby's live list. The frame
 * is only known to the node that hosts the battle; pixels never ride this row. */
export type LiveBattle={id:string;playerA:{handle:string;version:GameVersion};playerB:{handle:string;version:GameVersion};
  frame:number|null;startedAt:number};
export type WatchSide='a'|'b';
export function watchChoice(value:unknown):WatchSide{
  assertRecord(value);
  if(Object.keys(value).length!==1||!('side' in value)||!['a','b'].includes(value.side as string))
    throw new DomainError('INVALID_WATCH','Choose a side to watch.');
  return value.side as WatchSide;
}
export type BattleInput={type:'buttons';protocol:1;sequence:number;operationId:string;buttons:number};
export type BattleInputAck={type:'buttons-accepted';protocol:1;sequence:number;operationId:string;frame:number};
export function battleId(value:unknown):string{
  if(typeof value!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value))
    throw new DomainError('INVALID_BATTLE','Choose a valid trainer or battle.');
  return value.toLowerCase();
}
export function battleInput(value:unknown):BattleInput{
  assertRecord(value);
  if(Object.keys(value).some(key=>!['type','protocol','sequence','operationId','buttons'].includes(key))
    ||value.type!=='buttons'||value.protocol!==1||!Number.isSafeInteger(value.sequence)||Number(value.sequence)<0
    ||typeof value.operationId!=='string'||value.operationId.length<1||value.operationId.length>100
    ||!Number.isInteger(value.buttons)||Number(value.buttons)<0||Number(value.buttons)>BUTTON_MASK)
    throw new DomainError('INVALID_BATTLE_INPUT','Send a valid battle button state.');
  // Canonical ordering makes operation fingerprints independent of JSON order.
  return {type:'buttons',protocol:1,sequence:Number(value.sequence),operationId:value.operationId,buttons:Number(value.buttons)};
}
