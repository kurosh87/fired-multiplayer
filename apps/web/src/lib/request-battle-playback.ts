import { decodeBattleResponse, REQUEST_INPUT_FRAMES, REQUEST_INPUT_LEAD, type RequestBattleController, type RequestBattleInput } from '../../../../packages/battles/request-protocol.ts';
import { BattleScreenDecoder } from '../../../../packages/battles/screen.ts';
import type { Side } from '../../../../packages/battles/session.ts';

export const BATTLE_FRAME_MS=280896/16777216*1000;
/** Bounded personal samples. A caller retains short-press latches when full. */
export class BattleInputBuffer {
  private samples:number[]=[];
  sample(buttons:number):boolean {
    if(this.samples.length>=REQUEST_INPUT_LEAD)return false;
    this.samples.push(buttons);return true;
  }
  clear(){this.samples=[];}
  take(available=REQUEST_INPUT_FRAMES):RequestBattleInput['runs'] {
    const runs:RequestBattleInput['runs']=[];
    for(const buttons of this.samples.splice(0,Math.max(0,Math.min(REQUEST_INPUT_FRAMES,available)))){
      const last=runs.at(-1);if(last?.buttons===buttons)last.frames++;else runs.push({buttons,frames:1});
    }
    return runs;
  }
}

/** Independent responses each decode from their own keyframe. Validate a
 * complete response before queuing any pixels; old replies cannot rewind it. */
export class RequestBattlePlayback {
  private controller:RequestBattleController;
  private battleId:string;
  private side:Side;
  private sequence=-1;
  private acceptedFrame=-1;
  private displayedFrame=-1;
  private due=0;
  private pictures:{frame:number;pixels:Uint8ClampedArray<ArrayBuffer>}[]=[];
  get pending(){return this.pictures.length>0;}
  constructor(battleId:string,side:Side,controller:RequestBattleController){this.battleId=battleId;this.side=side;this.controller=controller;}
  accept(bytes:Uint8Array,request:RequestBattleInput){
    const {metadata,packets}=decodeBattleResponse(bytes);
    if(metadata.battleId!==this.battleId||metadata.side!==this.side||metadata.controller.connectionId!==this.controller.connectionId
      ||metadata.controller.epoch!==this.controller.epoch||metadata.operationId!==request.operationId||metadata.sequence!==request.sequence)
      throw new Error('The battle response belongs to another control connection.');
    if(metadata.sequence<=this.sequence||metadata.frame<this.acceptedFrame)return null;
    const decoder=new BattleScreenDecoder(),pictures:{frame:number;pixels:Uint8ClampedArray<ArrayBuffer>}[]=[];
    for(const packet of packets){
      if(!decoder.apply(packet))throw new Error('The battle picture sequence is invalid.');
      if(decoder.frame>metadata.frame)throw new Error('The battle picture is ahead of its acknowledgement.');
      pictures.push({frame:decoder.frame,pixels:decoder.pixels.slice()});
    }
    if(!pictures.length)throw new Error('The battle response has no personal picture.');
    this.sequence=metadata.sequence;this.acceptedFrame=metadata.frame;
    const through=this.pictures.at(-1)?.frame??this.displayedFrame;
    this.pictures.push(...pictures.filter(picture=>picture.frame>through));
    // Bound recovery latency and memory after slow/background requests.
    if(this.pictures.length>32)this.pictures.splice(0,this.pictures.length-32);
    return metadata;
  }
  next(now:number){
    if(!this.pictures.length||now<this.due)return undefined;
    const picture=this.pictures.shift()!;this.displayedFrame=picture.frame;
    const next=this.pictures[0];this.due=next?now+(next.frame-picture.frame)*BATTLE_FRAME_MS:now;
    return picture;
  }
}
