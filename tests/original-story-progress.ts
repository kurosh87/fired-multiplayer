import assert from 'node:assert/strict';
import type { WasmEngine } from '../packages/engine/runtime.ts';
import { originalGameProgress } from './original-game-progress.ts';

/** Read-only chapter assertions at the pinned original SaveBlock offsets. */
export function originalStoryProgress(engine:WasmEngine){
  const before=engine.digest(),base=originalGameProgress(engine);
  const c=engine.bindExtension<any>('kanto_lobby_save_abi_version',1,['GetMonData2']);
  const m=new DataView(c.memory.buffer),save=m.getUint32(c.gSaveBlock1Ptr.value,true),save2=m.getUint32(c.gSaveBlock2Ptr.value,true);
  const key=m.getUint32(save2+0xf20,true)&0xffff,flag=(id:number)=>Boolean(m.getUint8(save+0xee0+(id>>>3))&(1<<(id&7)));
  const quantity=(offset:number,slots:number,id:number)=>Array.from({length:slots},(_,i)=>({
    id:m.getUint16(save+offset+i*4,true),quantity:m.getUint16(save+offset+i*4+2,true)^key
  })).filter(item=>item.id===id).reduce((sum,item)=>sum+item.quantity,0);
  const party=Array.from({length:m.getUint8(c.gPlayerPartyCount.value)},(_,slot)=>{
    const get=(field:number)=>c.GetMonData2(c.gPlayerParty.value+100*slot,field);assert.equal(get(4),0,'No Bad Eggs');
    return {species:get(11),personality:get(0)>>>0,trainerId:get(1)>>>0,experience:get(25),level:get(56),hp:get(57),maxHp:get(58),
      status:get(55)>>>0,heldItem:get(12),moves:[13,14,15,16].map(get),pp:[17,18,19,20].map(get)};
  });
  const progress={...base,party,runningShoes:flag(0x82f),fossilReceived:flag(0x232),domeFossil:flag(0x272),helixFossil:flag(0x273),
    rivalCerulean:flag(0x500+334),fameCheckerReceived:flag(0x29b),fameChecker:quantity(0x3b8,30,363),
    billHelped:flag(0x233),ssTicketReceived:flag(0x234),ssTicketDuplicateFlag:flag(0x235),ssTickets:quantity(0x3b8,30,265),nuggets:quantity(0x310,42,110),
    nuggetBridgeScene:m.getUint16(save+0x1000+(0x406b-0x4000)*2,true),ceruleanRivalScene:m.getUint16(save+0x1000+(0x4052-0x4000)*2,true),billsPc:flag(0x834),
    mistyDefeated:flag(0x4b1),tm03Received:flag(0x297),tm03:quantity(0x464,58,291),
    evolutions:(m.getUint32(save+0x1200+14*4,true)^m.getUint32(save2+0xf20,true))>>>0,
    pokeCenters:(m.getUint32(save+0x1200+15*4,true)^m.getUint32(save2+0xf20,true))>>>0,
    domeFossils:quantity(0x3b8,30,358),helixFossils:quantity(0x3b8,30,357),
    defeatedTrainers:Array.from({length:743},(_,id)=>flag(0x500+id)?id:-1).filter(id=>id>=0),
    questLog:m.getUint8(c.gQuestLogState.value),fileStatus:m.getUint16(c.gSaveFileStatus.value,true),
    fieldLocked:c.ArePlayerFieldControlsLocked(),scriptEnabled:c.ScriptContext_IsEnabled()};
  assert.equal(engine.digest(),before,'Story inspection must not change canonical gameplay.');return progress;
}
