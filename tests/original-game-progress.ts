import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { WasmEngine } from '../packages/engine/runtime.ts';

/** Passive readers at the pinned, independently checked GBA SaveBlock offsets.
 * FlagGet/VarGet can record quest-log observations and must not be used here. */
export function originalGameProgress(engine:WasmEngine){
  const before=engine.digest(),core=engine.bindExtension<any>('kanto_lobby_save_abi_version',1,[]);
  const m=new DataView(core.memory.buffer),save=m.getUint32(core.gSaveBlock1Ptr.value,true),save2=m.getUint32(core.gSaveBlock2Ptr.value,true);
  assert(save>0&&save+0x3d68<=m.byteLength&&save2>0&&save2+0xf24<=m.byteLength);
  const key=m.getUint32(save2+0xf20,true),flag=(id:number)=>Boolean(m.getUint8(save+0xee0+(id>>>3))&(1<<(id&7)));
  const quantity=(offset:number,slots:number,item:number)=>Array.from({length:slots},(_,i)=>({
    id:m.getUint16(save+offset+i*4,true),quantity:m.getUint16(save+offset+i*4+2,true)^(key&0xffff)
  })).filter(value=>value.id===item).reduce((sum,value)=>sum+value.quantity,0);
  const storage=m.getUint32(core.gPokemonStoragePtr.value,true);assert(storage>0&&storage+0x83d0<=m.byteLength);
  const progress={map:[m.getUint8(save+4),m.getUint8(save+5)],position:[m.getInt16(save,true),m.getInt16(save+2,true)],
    badges:Array.from({length:8},(_,i)=>flag(0x820+i)),brockDefeated:flag(0x4b0),brockTrainer:flag(0x500+414),liamDefeated:flag(0x500+142),
    tm39Received:flag(0x254),tm39:quantity(0x464,58,327),teachyTv:quantity(0x3b8,30,366),balls:quantity(0x430,13,4),pokedex:flag(0x829),
    money:(m.getUint32(save+0x290,true)^key)>>>0,trades:(m.getUint32(save+0x1200+21*4,true)^key)>>>0,
    storageSha256:createHash('sha256').update(new Uint8Array(core.memory.buffer,storage,0x83d0)).digest('hex')};
  assert.equal(engine.digest(),before,'Progress inspection must not change canonical state.');return progress;
}
