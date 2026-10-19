import {BUTTON_MASK,DomainError} from '../protocol/index.ts';
import type {EngineManifest} from '../engine/runtime.ts';
import type {BattleResult,Side} from './session.ts';
import {OriginalBattleCore} from './original-core.ts';
import {transferBattleBlocks} from './transport.ts';

export type BattleArtifact={bytes:Uint8Array;manifest:EngineManifest;seed:number};
export type BattlePairSnapshot={protocol:1;frame:number;artifacts:[string,string];memories:[Uint8Array,Uint8Array]};

/** Private server simulation. Its only browser-facing data is screen(side).
 * Original turn and replacement requests are read from C, never inferred from
 * opponent buttons or approximated with JavaScript battle mechanics. */
export class OriginalBattlePair{
  private consoles:[OriginalBattleCore,OriginalBattleCore];
  private frameNumber:number;
  private closed=false;
  private constructor(consoles:[OriginalBattleCore,OriginalBattleCore],frame:number){this.consoles=consoles;this.frameNumber=frame;}
  static async create(artifacts:[BattleArtifact,BattleArtifact],saves:[Uint8Array,Uint8Array]):Promise<OriginalBattlePair>{
    const first=await OriginalBattleCore.create(artifacts[0].bytes,artifacts[0].manifest,artifacts[0].seed,saves[0],0);
    let second:OriginalBattleCore|undefined;
    try{
      second=await OriginalBattleCore.create(artifacts[1].bytes,artifacts[1].manifest,artifacts[1].seed,saves[1],1);
      const a=first.hello(),b=second.hello();first.start(b);second.start(a);
      return new OriginalBattlePair([first,second],0);
    }catch(error){first.close();second?.close();throw error;}
  }
  static async restore(artifacts:[BattleArtifact,BattleArtifact],saved:BattlePairSnapshot):Promise<OriginalBattlePair>{
    if(saved.protocol!==1||!Number.isSafeInteger(saved.frame)||saved.frame<0
      ||saved.artifacts.some((id,side)=>id!==artifacts[side]!.manifest.id))
      throw new DomainError('BATTLE_CHECKPOINT_INVALID','The saved consoles require their original artifacts.',503);
    const first=await OriginalBattleCore.restore(artifacts[0].bytes,artifacts[0].manifest,artifacts[0].seed,saved.memories[0]);
    let second:OriginalBattleCore|undefined;
    try{
      second=await OriginalBattleCore.restore(artifacts[1].bytes,artifacts[1].manifest,artifacts[1].seed,saved.memories[1]);
      if(Math.max(first.engine.frame,second.engine.frame)!==saved.frame
        ||[first,second].some(core=>core.engine.frame>saved.frame||core.phase===2&&core.engine.frame!==saved.frame))
        throw new DomainError('BATTLE_CHECKPOINT_INVALID','The private consoles have inconsistent frame clocks.',503);
      return new OriginalBattlePair([first,second],saved.frame);
    }catch(error){first.close();second?.close();throw error;}
  }
  private open():void{if(this.closed)throw new DomainError('BATTLE_RECOVERY_REQUIRED','Restore the battle before using its consoles.',409);}
  get frame():number{this.open();return this.frameNumber;}
  get done():boolean{this.open();return this.consoles.every(core=>core.phase===3);}
  tick(buttons:[number,number],onBlock?:(packet:Uint8Array)=>void):void{
    this.open();
    if(buttons.length!==2||buttons.some(mask=>!Number.isInteger(mask)||mask<0||mask>BUTTON_MASK))
      throw new DomainError('INVALID_BATTLE_INPUT','Invalid server battle buttons.',503);
    if(this.done)throw new DomainError('BATTLE_FINISHED','Both original consoles have finished.',409);
    try{
      transferBattleBlocks(this.consoles,onBlock);
      for(const [side,core] of this.consoles.entries()){
        if(core.phase===2)core.engine.advance([{buttons:buttons[side]!,frames:1}]);
        if(![2,3].includes(core.phase))throw new DomainError('BATTLE_ENGINE_FAILED','An original console stopped during the match.',503);
      }
      this.frameNumber++;
    }catch(error){this.close();throw error;}
  }
  decision():{kind:'turn'|'switch'|null;mask:number}{
    this.open();if(this.done)return {kind:null,mask:0};
    const master=this.consoles[0].decision();
    if(master.turnSelection)return {kind:'turn',mask:master.requiredMask};
    const mask=this.consoles.reduce((mask,core,side)=>core.decision().localRequest===3?mask|(1<<side):mask,0);
    return {kind:mask?'switch':null,mask};
  }
  digests():[string,string]{this.open();return [this.consoles[0].engine.digest(),this.consoles[1].engine.digest()];}
  screen(side:Side):Uint8Array{
    this.open();if(side!=='a'&&side!=='b')throw new DomainError('INVALID_BATTLE_SIDE','Choose a valid battle participant.',403);
    return this.consoles[side==='a'?0:1].screen();
  }
  snapshot():BattlePairSnapshot{
    this.open();return {protocol:1,frame:this.frameNumber,
      artifacts:[this.consoles[0].engine.manifest.id,this.consoles[1].engine.manifest.id],
      memories:[this.consoles[0].engine.snapshot(),this.consoles[1].engine.snapshot()]};
  }
  result():BattleResult|undefined{
    this.open();if(!this.done)return undefined;
    const a=this.consoles[0].read(1),b=this.consoles[1].read(1);
    if(a===1&&b===2)return {winner:'a',reason:'finished'};
    if(a===2&&b===1)return {winner:'b',reason:'finished'};
    if(a===3&&b===3)return {winner:null,reason:'finished'};
    throw new DomainError('BATTLE_RESULT_INVALID','The original consoles returned inconsistent outcomes.',503);
  }
  close():void{if(this.closed)return;this.closed=true;this.consoles.forEach(core=>core.close());}
}
