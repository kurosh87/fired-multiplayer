/** Battle viewers receive only their rendered screen. Original parties,
 * controller buffers, pending choices and memory snapshots stay on the server.
 * This codec carries pixels; it makes no game decisions. Compression belongs
 * to the authenticated transport, outside this browser-compatible module. */
export const BATTLE_WIDTH=240, BATTLE_HEIGHT=160;
export const BATTLE_SCREEN_BYTES=BATTLE_WIDTH*BATTLE_HEIGHT*4;
const TILE=8, COLUMNS=BATTLE_WIDTH/TILE, TILES=COLUMNS*BATTLE_HEIGHT/TILE;
const TILE_BYTES=TILE*TILE*4, ENTRY_BYTES=2+TILE_BYTES, HEADER=24;
const MAGIC=0x3146424b, KEYFRAME=1, NO_BASE=0xffffffff;

function integer(value:number):void {
  if(!Number.isInteger(value)||value<0||value>=NO_BASE)throw new Error('Invalid battle screen counter.');
}
function source(pixels:Uint8Array):void {if(pixels.byteLength!==BATTLE_SCREEN_BYTES)throw new Error('Invalid battle screen size.');}
function rowOffset(tile:number,row:number):number {
  return ((Math.floor(tile/COLUMNS)*TILE+row)*BATTLE_WIDTH+(tile%COLUMNS)*TILE)*4;
}

export class BattleScreenEncoder {
  private previous:Uint8Array|undefined;
  private sequence=-1;
  private frame=-1;
  encode(pixels:Uint8Array,frame:number,forceKeyframe=false):Uint8Array|undefined {
    source(pixels);integer(frame);
    if(frame<this.frame)throw new Error('A battle screen cannot move backwards within a stream.');
    const changed:number[]=[];
    if(this.previous && !forceKeyframe)for(let tile=0;tile<TILES;tile++){
      let different=false;
      for(let row=0;row<TILE&&!different;row++){
        const start=rowOffset(tile,row);
        for(let byte=0;byte<TILE*4;byte++)if(pixels[start+byte]!==this.previous[start+byte]){different=true;break;}
      }
      if(different)changed.push(tile);
    }
    if(this.previous&&!forceKeyframe&&!changed.length)return undefined;
    const keyframe=!this.previous||forceKeyframe||changed.length*ENTRY_BYTES>=BATTLE_SCREEN_BYTES;
    const packet=new Uint8Array(HEADER+(keyframe?BATTLE_SCREEN_BYTES:changed.length*ENTRY_BYTES));
    const header=new DataView(packet.buffer);const sequence=this.sequence+1;integer(sequence);
    header.setUint32(0,MAGIC,true);header.setUint16(4,1,true);header.setUint16(6,keyframe?KEYFRAME:0,true);
    header.setUint32(8,sequence,true);header.setUint32(12,keyframe?NO_BASE:this.sequence,true);
    header.setUint32(16,frame,true);header.setUint16(20,keyframe?0:changed.length,true);
    if(keyframe)packet.set(pixels,HEADER);
    else for(let entry=0;entry<changed.length;entry++){
      const tile=changed[entry]!,offset=HEADER+entry*ENTRY_BYTES;header.setUint16(offset,tile,true);
      for(let row=0;row<TILE;row++){
        const start=rowOffset(tile,row);packet.set(pixels.subarray(start,start+TILE*4),offset+2+row*TILE*4);
      }
    }
    this.previous=Uint8Array.from(pixels);this.sequence=sequence;this.frame=frame;
    return packet;
  }
}

export class BattleScreenDecoder {
  readonly pixels=new Uint8ClampedArray(BATTLE_SCREEN_BYTES);
  private sequence=-1;
  private frameNumber=-1;
  get frame():number{return this.frameNumber;}
  apply(packet:Uint8Array):boolean {
    if(packet.byteLength<HEADER)throw new Error('Truncated battle screen.');
    const header=new DataView(packet.buffer,packet.byteOffset,packet.byteLength);
    const flags=header.getUint16(6,true),sequence=header.getUint32(8,true),base=header.getUint32(12,true);
    const frame=header.getUint32(16,true),count=header.getUint16(20,true),keyframe=flags===KEYFRAME;
    if(header.getUint32(0,true)!==MAGIC||header.getUint16(4,true)!==1||flags>KEYFRAME||header.getUint16(22,true)!==0)
      throw new Error('Unsupported battle screen protocol.');
    integer(sequence);integer(frame);
    if(keyframe?(count!==0||base!==NO_BASE||packet.length!==HEADER+BATTLE_SCREEN_BYTES)
      :(count<1||count>TILES||packet.length!==HEADER+count*ENTRY_BYTES))throw new Error('Invalid battle screen payload.');
    let previous=-1;
    if(!keyframe)for(let entry=0;entry<count;entry++){
      const tile=header.getUint16(HEADER+entry*ENTRY_BYTES,true);
      if(tile<=previous||tile>=TILES)throw new Error('Invalid battle screen tile order.');previous=tile;
    }
    if(sequence<=this.sequence)return false;
    if(frame<this.frameNumber||(!keyframe&&(base!==this.sequence||sequence!==this.sequence+1)))
      throw new Error('A battle screen keyframe is required to recover this stream.');
    // Validate the complete message before touching the visible picture.
    if(keyframe)this.pixels.set(packet.subarray(HEADER));
    else for(let entry=0;entry<count;entry++){
      const offset=HEADER+entry*ENTRY_BYTES,tile=header.getUint16(offset,true);
      for(let row=0;row<TILE;row++)this.pixels.set(packet.subarray(offset+2+row*TILE*4,offset+2+(row+1)*TILE*4),rowOffset(tile,row));
    }
    this.sequence=sequence;this.frameNumber=frame;return true;
  }
}
