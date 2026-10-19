import { WasmEngine,type EngineManifest } from '../engine/runtime.ts';
import { DomainError } from '../protocol/index.ts';

type BattleExports={memory:WebAssembly.Memory;kanto_battle_open(player:number):number;kanto_battle_phase():number;
  kanto_battle_hello_ptr():number;kanto_battle_peer_ptr():number;kanto_battle_hello_size():number;kanto_battle_start():number;
  kanto_battle_out_ptr():number;kanto_battle_in_ptr():number;kanto_battle_block_size():number;
  kanto_battle_ack(serial:number):number;kanto_battle_deliver():number;kanto_battle_read(key:number,battler:number):number;kanto_battle_decision():number};
export const BATTLE_CORE_EXPORTS=['kanto_battle_open','kanto_battle_phase','kanto_battle_hello_ptr','kanto_battle_peer_ptr','kanto_battle_hello_size',
  'kanto_battle_start','kanto_battle_out_ptr','kanto_battle_in_ptr','kanto_battle_block_size','kanto_battle_ack','kanto_battle_deliver','kanto_battle_read','kanto_battle_decision'] as const;

/** Experimental original-C two-console link endpoint. Opaque transport and
 * cartridges belong to the trusted server, never a client-supplied snapshot. */
export class OriginalBattleCore {
  readonly engine:WasmEngine;
  private core:BattleExports;
  private constructor(engine:WasmEngine,core:BattleExports){this.engine=engine;this.core=core;}
  static async create(bytes:Uint8Array,manifest:EngineManifest,seed:number,flash:Uint8Array,player:0|1):Promise<OriginalBattleCore>{
    const engine=await WasmEngine.create(bytes,manifest,seed,flash);
    try {
      const core=engine.bindExtension<BattleExports>('kanto_battle_abi_version',1,BATTLE_CORE_EXPORTS);
      if(core.kanto_battle_open(player)!==0)throw new DomainError('INVALID_BATTLE_PARTY','The original game rejected this cartridge or battle party.',409);
      return new OriginalBattleCore(engine,core);
    }catch(error){engine.close();throw error;}
  }
  static async restore(bytes:Uint8Array,manifest:EngineManifest,seed:number,checkpoint:Uint8Array):Promise<OriginalBattleCore>{
    const engine=await WasmEngine.create(bytes,manifest,seed);
    try {
      engine.restore(checkpoint);
      const core=engine.bindExtension<BattleExports>('kanto_battle_abi_version',1,BATTLE_CORE_EXPORTS);
      if(![2,3].includes(core.kanto_battle_phase()))throw new DomainError('BATTLE_CHECKPOINT_INVALID','This battle checkpoint cannot be resumed.',503);
      return new OriginalBattleCore(engine,core);
    }catch(error){engine.close();throw error;}
  }
  private region(pointer:number,size:number):Uint8Array{
    void this.engine.frame;
    if(!Number.isInteger(pointer)||pointer<=0||!Number.isInteger(size)||size<1||size>1024||pointer+size>this.core.memory.buffer.byteLength)
      throw new DomainError('ENGINE_ABI_ERROR','The battle core exported an invalid transport region.',503);
    return new Uint8Array(this.core.memory.buffer,pointer,size);
  }
  get phase():number{void this.engine.frame;return this.core.kanto_battle_phase();}
  decision():{turnSelection:boolean;requiredMask:number;localRequest:number}{
    void this.engine.frame;const value=this.core.kanto_battle_decision()>>>0;
    return {turnSelection:Boolean(value&0x100),requiredMask:value&3,localRequest:(value>>>16)&3};
  }
  hello():Uint8Array{return this.region(this.core.kanto_battle_hello_ptr(),this.core.kanto_battle_hello_size()).slice();}
  start(peer:Uint8Array):void{
    if(peer.length!==this.core.kanto_battle_hello_size())throw new DomainError('INVALID_BATTLE_PARTNER','Incompatible battle metadata.',409);
    this.region(this.core.kanto_battle_peer_ptr(),peer.length).set(peer);
    if(this.core.kanto_battle_start()!==0)throw new DomainError('INVALID_BATTLE_PARTNER','The original game rejected this battle partner.',409);
  }
  outgoing():Uint8Array|undefined{
    void this.engine.frame;const pointer=this.core.kanto_battle_out_ptr();
    return pointer?this.region(pointer,this.core.kanto_battle_block_size()).slice():undefined;
  }
  acknowledge(packet:Uint8Array):void{
    void this.engine.frame;
    if(packet.byteLength!==this.core.kanto_battle_block_size())throw new Error('Invalid battle block size.');
    const serial=new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(8,true);
    if(this.core.kanto_battle_ack(serial)!==0)throw new DomainError('BATTLE_PACKET_CHANGED','This battle block is no longer pending.',409);
  }
  deliver(packet:Uint8Array):boolean{
    if(packet.byteLength!==this.core.kanto_battle_block_size())throw new DomainError('INVALID_BATTLE_PACKET','Invalid battle block size.',409);
    this.region(this.core.kanto_battle_in_ptr(),packet.length).set(packet);
    const result=this.core.kanto_battle_deliver();
    if(result===-3)return false;
    if(result!==0&&result!==1)throw new DomainError('INVALID_BATTLE_PACKET',`The original transport rejected this block (${result}).`,409);
    return true;
  }
  read(key:number,battler=0):number{
    if(!Number.isInteger(key)||key<0||key>16||!Number.isInteger(battler)||battler<0||battler>5)throw new Error('Invalid battle inspection key.');
    void this.engine.frame;return this.core.kanto_battle_read(key,battler)>>>0;
  }
  screen():Uint8Array{
    void this.engine.frame;
    const draw=this.engine.bindExtension<{memory:WebAssembly.Memory;kanto_render_frame():number;
      kanto_framebuffer_ptr():number;kanto_framebuffer_size():number}>('kanto_battle_abi_version',1,
      ['kanto_render_frame','kanto_framebuffer_ptr','kanto_framebuffer_size']);
    if(draw.kanto_render_frame()!==0)throw new DomainError('BATTLE_RENDER_FAILED','The original game could not render this battle.',503);
    const pointer=draw.kanto_framebuffer_ptr(),size=draw.kanto_framebuffer_size();
    if(!Number.isInteger(pointer)||pointer<=0||size!==240*160*4||pointer+size>draw.memory.buffer.byteLength)
      throw new DomainError('ENGINE_ABI_ERROR','The original game exported an invalid battle screen.',503);
    // Never return a view whose .buffer exposes the rest of private core RAM.
    return new Uint8Array(draw.memory.buffer,pointer,size).slice();
  }
  close():void{this.engine.close();}
}
