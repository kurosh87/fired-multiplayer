import { useEffect, useRef, useState } from 'react';
import { BattlePanel } from './battle-panel.tsx';
import { ApiError } from './api.ts';
import { requestBattleFetch } from './lib/request-battle-fetch.ts';
import { BattleInputBuffer, RequestBattlePlayback, BATTLE_FRAME_MS } from './lib/request-battle-playback.ts';
import { REQUEST_INPUT_LEAD, type RequestBattleBootstrap, type RequestBattleConnection, type RequestBattleInput } from '../../../packages/battles/request-protocol.ts';
import type { BattleView } from '../../../packages/battles/protocol.ts';
import type { BattleResult } from '../../../packages/battles/session.ts';

const keys:Record<string,number>={KeyZ:1,KeyX:2,Backspace:4,Enter:8,ArrowRight:16,ArrowLeft:32,ArrowUp:64,ArrowDown:128,KeyS:256,KeyA:512};
export function RequestBattle({battle:initial,onExit}:{battle:BattleView;onExit():void}){
  const canvas=useRef<HTMLCanvasElement>(null),touch=useRef(new Map<number,number>()),pressed=useRef(0);
  const [result,setResult]=useState<BattleResult|null>(initial.result),[message,setMessage]=useState('Connecting to your battle…');
  const [error,setError]=useState(''),[connected,setConnected]=useState(false),[connectionId,setConnectionId]=useState(()=>crypto.randomUUID());
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false);
  const blocked=useRef(false),release=useRef(()=>{}),forfeiting=useRef(false);
  blocked.current=confirm;
  useEffect(()=>{
    if(initial.result)return;
    let mounted=true,ready=false,finished=false,stopped=false,keyboard=0,gamepadNeutral=false,animation=0;
    const lifetime=new AbortController(),buffer=new BattleInputBuffer();
    let playback:RequestBattlePlayback|undefined;
    const signal=()=>AbortSignal.any([lifetime.signal,AbortSignal.timeout(12_000)]);
    const wait=(ms:number)=>new Promise<void>(resolve=>{
      if(lifetime.signal.aborted){resolve();return;}
      const done=()=>{clearTimeout(timer);lifetime.signal.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,ms);lifetime.signal.addEventListener('abort',done,{once:true});
    });
    const finish=(value:BattleResult)=>{
      finished=true;ready=false;clearInterval(sampler);buffer.clear();touch.current.clear();pressed.current=0;forfeiting.current=false;
      setResult(value);setConnected(false);setBusy(false);setConfirm(false);setError('');setMessage('Battle complete.');
    };
    const clear=()=>{keyboard=0;gamepadNeutral=false;touch.current.clear();pressed.current=0;buffer.clear();};
    release.current=clear;
    const down=(event:KeyboardEvent)=>{
      if(!ready||finished||blocked.current||document.hidden||event.repeat||event.target instanceof HTMLElement&&(event.target.closest('input,textarea,select,[contenteditable]')||event.code==='Enter'&&event.target.closest('button,a')))return;
      const bit=keys[event.code];if(bit){event.preventDefault();keyboard|=bit;pressed.current|=bit;}
    };
    const up=(event:KeyboardEvent)=>{const bit=keys[event.code];if(bit){if(ready&&!blocked.current)event.preventDefault();keyboard&=~bit;}};
    const hidden=()=>{if(document.hidden)clear();};
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',clear);document.addEventListener('visibilitychange',hidden);
    const sampler=setInterval(()=>{
      if(!ready||finished)return;
      let buttons=keyboard,padButtons=0;
      if(!document.hidden&&!blocked.current){
        const pad=navigator.getGamepads?.().find(value=>value?.connected);
        if(pad){
          for(const [index,bit] of [[0,1],[1,2],[4,512],[5,256],[8,4],[9,8],[12,64],[13,128],[14,32],[15,16]])if(pad.buttons[index!]?.pressed)padButtons|=bit!;
          if((pad.axes[0]??0)<-.4)padButtons|=32;if((pad.axes[0]??0)>.4)padButtons|=16;
          if((pad.axes[1]??0)<-.4)padButtons|=64;if((pad.axes[1]??0)>.4)padButtons|=128;
        }
        if(!padButtons)gamepadNeutral=true;if(gamepadNeutral)buttons|=padButtons;
        for(const bit of touch.current.values())buttons|=bit;
        buttons|=pressed.current;
      }else{buttons=0;pressed.current=0;gamepadNeutral=false;}
      if(buffer.sample(buttons))pressed.current=0;
    },BATTLE_FRAME_MS);
    const paint=(now:number)=>{
      if(!mounted)return;
      const picture=playback?.next(now);
      if(picture&&canvas.current){canvas.current.getContext('2d')?.putImageData(new ImageData(picture.pixels,240,160),0,0);canvas.current.dataset.frame=String(picture.frame);}
      if(!(finished||stopped)||playback?.pending)animation=requestAnimationFrame(paint);
    };
    animation=requestAnimationFrame(paint);
    async function run(){
      let opening:{connectionId:string;expectedEpoch:number}|undefined,connection:RequestBattleConnection|undefined,pending:RequestBattleInput|undefined;
      let failures=0;
      while(mounted&&!finished){
        const started=performance.now();
        try{
          if(!connection){
            if(!opening){
              const bootstrap=await requestBattleFetch(initial.id,undefined,signal()) as RequestBattleBootstrap;
              if(!mounted)return;if(bootstrap.battle.result){finish(bootstrap.battle.result);return;}
              opening={connectionId,expectedEpoch:bootstrap.controllerEpoch};
            }
            connection=await requestBattleFetch(initial.id+'/open',opening,signal()) as RequestBattleConnection;
            if(!mounted)return;
            if(connection.battle.id!==initial.id||connection.battle.side!==initial.side||connection.controller.connectionId!==connectionId)throw new Error('The battle connection is invalid.');
            playback=new RequestBattlePlayback(initial.id,initial.side,connection.controller);
          }
          if(!pending){
            const action=forfeiting.current?'forfeit':'step';
            pending={protocol:1,operationId:crypto.randomUUID(),sequence:connection.nextSequence,controller:connection.controller,action,
              runs:action==='forfeit'?[]:buffer.take(REQUEST_INPUT_LEAD-Math.max(0,connection.inputThrough-connection.frame))};
          }
          const bytes=await requestBattleFetch(initial.id+'/step',pending,signal(),true) as Uint8Array;
          if(!mounted)return;
          const metadata=playback!.accept(bytes,pending);if(!metadata)throw new Error('The battle acknowledgement is out of order.');
          connection={...connection,nextSequence:metadata.nextSequence,frame:metadata.frame,inputThrough:metadata.inputThrough};pending=undefined;failures=0;
          if(metadata.result){finish(metadata.result);return;}
          ready=true;setConnected(true);setError('');setMessage('Connected · choose your next move.');
          await wait(Math.max(0,250-(performance.now()-started)));
        }catch(failure){
          if(!mounted)return;
          if(failure instanceof ApiError&&['BATTLE_REQUEST_BUSY','BATTLE_REQUEST_CHANGED'].includes(failure.code)){
            // Writer contention does not mean the controller disconnected.
            // Keep queued/latching taps and retry the same operation fairly.
            await wait(100+Math.floor(Math.random()*100));continue;
          }
          ready=false;clear();setConnected(false);
          const retryable=!(failure instanceof ApiError)||failure.status>=500;
          if(!retryable){stopped=true;clearInterval(sampler);setError(failure instanceof Error?failure.message:'Reconnect to restore your battle.');setBusy(false);setConfirm(false);forfeiting.current=false;return;}
          setMessage('Reconnecting… Your battle continues while disconnected.');
          await wait(Math.min(3000,500*2**Math.min(failures++,3)));
        }
      }
    }
    void run();
    return()=>{mounted=false;ready=false;lifetime.abort();clearInterval(sampler);cancelAnimationFrame(animation);clear();release.current=()=>{};
      window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',clear);document.removeEventListener('visibilitychange',hidden);};
  },[initial.id,connectionId]);
  return <BattlePanel initial={initial} canvasRef={canvas} result={result} message={message} error={error} connected={connected} confirm={confirm} busy={busy} canForfeit={connected}
    onExit={onExit} onReconnect={()=>{release.current();setError('');setConnectionId(crypto.randomUUID());}}
    onForfeit={()=>{blocked.current=true;release.current();setConfirm(true);}}
    onConfirm={()=>{setBusy(true);forfeiting.current=true;release.current();}} onKeepPlaying={()=>setConfirm(false)}
    onControlDown={(pointer,bit)=>{if(connected&&!blocked.current){touch.current.set(pointer,bit);pressed.current|=bit;}}}
    onControlUp={pointer=>touch.current.delete(pointer)}/>;
}
