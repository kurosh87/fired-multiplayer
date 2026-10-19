import { BattlePanel } from './battle-panel.tsx';
import { RequestBattle } from './request-battle.tsx';
import { httpBattles } from './lib/battle-api.ts';
import {useEffect,useRef,useState} from 'react';
import {maintainSocketAuthentication} from './lib/socket-auth.ts';
import './battles.css';
import {api,API_URL,token} from './api.ts';
import {BattleScreenDecoder} from '../../../packages/battles/screen.ts';
import type {BattleView} from '../../../packages/battles/protocol.ts';
import type {BattleResult} from '../../../packages/battles/session.ts';

const keys:Record<string,number>={KeyZ:1,KeyX:2,Backspace:4,Enter:8,ArrowRight:16,ArrowLeft:32,ArrowUp:64,ArrowDown:128,KeyS:256,KeyA:512};


function SocketBattle({battle:initial,onExit}:{battle:BattleView;onExit():void}){
  const canvas=useRef<HTMLCanvasElement>(null),touch=useRef(new Map<number,number>()),touchChanged=useRef(()=>{});
  const [result,setResult]=useState<BattleResult|null>(initial.result),[message,setMessage]=useState('Connecting to your battle…');
  const [error,setError]=useState(''),[connected,setConnected]=useState(false),[attempt,setAttempt]=useState(0);
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false);
  const controlsBlocked=useRef(false),releaseControls=useRef(()=>{});
  controlsBlocked.current=confirm;
  const finished=useRef(Boolean(initial.result));
  useEffect(()=>{
    if(finished.current)return;
    let mounted=true,socket:WebSocket|undefined,retry:ReturnType<typeof setTimeout>|undefined;
    let stopAuthentication:(()=>void)|undefined;
    let ready=false,keyboard=0,gamepad=0,gamepadNeutral=false,nextSequence=0,inflight:{sequence:number;operationId:string}|undefined;
    let queue:number[]=[],desired=0,sent=0,lastSent=0,failures=0;
    const done=(value:BattleResult)=>{
      finished.current=true;ready=false;queue=[];touch.current.clear();setResult(value);setConnected(false);setError('');setMessage('Battle complete.');
    };
    async function connect(){
      if(!mounted||finished.current)return;
      ready=false;inflight=undefined;queue=[];desired=0;sent=0;keyboard=0;gamepad=0;gamepadNeutral=false;touch.current.clear();
      try{
        const view=await api<BattleView>(`/api/battles/${initial.id}`);
        if(!mounted)return;if(view.result){done(view.result);return;}
        await api(`/api/battles/${initial.id}/open`,{});
        const accessToken=await token();if(!mounted)return;
        const url=new URL('/api/battle-play',API_URL);url.protocol=url.protocol==='https:'?'wss:':'ws:';
        const decoder=new BattleScreenDecoder(),picture=new ImageData(decoder.pixels,240,160),connection=new WebSocket(url);socket=connection;connection.binaryType='arraybuffer';
        stopAuthentication?.();stopAuthentication=maintainSocketAuthentication(connection,token);
        connection.onopen=()=>connection.send(JSON.stringify({type:'authenticate',protocol:1,token:accessToken,battleId:initial.id}));
        connection.onmessage=event=>{
          if(!mounted||socket!==connection)return;
          try{
            if(event.data instanceof ArrayBuffer){
              if(decoder.apply(new Uint8Array(event.data)))canvas.current?.getContext('2d')?.putImageData(picture,0,0);
              return;
            }
            const body=JSON.parse(event.data);
            if(body.type==='ready'){
              if(!Number.isSafeInteger(body.nextSequence)||body.nextSequence<0)throw new Error('Invalid battle connection.');
              nextSequence=body.nextSequence;ready=true;failures=0;setConnected(true);setError('');setMessage('Connected · choose your next move.');
            }else if(body.type==='buttons-accepted'){
              if(!inflight||body.sequence!==inflight.sequence||body.operationId!==inflight.operationId)throw new Error('Your controls need to reconnect.');
              nextSequence++;inflight=undefined;
            }else if(body.type==='finished')done(body.result);
            else if(body.type==='auth-required'||body.type==='auth-refreshed'){ /* Shared authentication handler. */ }
            else if(body.type==='error'){setError(body.message);ready=false;connection.close();}
            else throw new Error('Unsupported battle message.');
          }catch(failure){setError(failure instanceof Error?failure.message:'Reconnect to restore your battle.');connection.close();}
        };
        connection.onclose=()=>{
          if(!mounted||socket!==connection)return;ready=false;setConnected(false);
          if(!finished.current){setMessage('Reconnecting… Your battle continues while disconnected.');schedule();}
        };
        connection.onerror=()=>connection.close();
      }catch(failure){if(mounted){setConnected(false);setError(failure instanceof Error?failure.message:'Could not connect to your battle.');schedule();}}
    }
    function schedule(){if(!mounted||finished.current)return;retry=setTimeout(()=>void connect(),Math.min(10_000,1000*2**Math.min(failures++,4)));}
    const changed=()=>{
      if(!ready)return;
      let buttons=keyboard|gamepad;for(const mask of touch.current.values())buttons|=mask;
      if(document.hidden||controlsBlocked.current)buttons=0;
      if(buttons!==desired){desired=buttons;queue.push(buttons);}
    };
    touchChanged.current=changed;
    const down=(event:KeyboardEvent)=>{
      if(!ready||finished.current||controlsBlocked.current||event.code==='Enter'&&event.target instanceof HTMLElement&&event.target.closest('button,a'))return;
      const bit=keys[event.code];if(bit){event.preventDefault();keyboard|=bit;changed();}
    };
    const up=(event:KeyboardEvent)=>{const bit=keys[event.code];if(bit){if(ready&&!finished.current&&!controlsBlocked.current)event.preventDefault();keyboard&=~bit;changed();}};
    const release=()=>{keyboard=0;gamepad=0;gamepadNeutral=false;touch.current.clear();queue=[];desired=0;if(sent)queue.push(0);};
    releaseControls.current=release;
    const hidden=()=>{if(document.hidden)release();};
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',release);document.addEventListener('visibilitychange',hidden);
    const controlsTimer=setInterval(()=>{
      if(!ready||socket?.readyState!==WebSocket.OPEN||finished.current)return;
      let buttons=0;
      if(!document.hidden&&!controlsBlocked.current){
        const pad=navigator.getGamepads?.().find(item=>item?.connected);
        if(pad){
          for(const [index,bit] of [[0,1],[1,2],[4,512],[5,256],[8,4],[9,8],[12,64],[13,128],[14,32],[15,16]])if(pad.buttons[index!]?.pressed)buttons|=bit!;
          if((pad.axes[0]??0)<-.4)buttons|=32;if((pad.axes[0]??0)>.4)buttons|=16;
          if((pad.axes[1]??0)<-.4)buttons|=64;if((pad.axes[1]??0)>.4)buttons|=128;
        }
      }
      if(controlsBlocked.current)gamepadNeutral=false;else if(!buttons)gamepadNeutral=true;gamepad=gamepadNeutral?buttons:0;changed();
      if(queue.length>24||socket.bufferedAmount>65536){socket.close();return;}
      // Preserve short taps for two console frames. Only the server chooses
      // actual frame boundaries; every command is durably acknowledged.
      if(!inflight&&queue.length&&Date.now()-lastSent>=40){
        const buttons=queue.shift()!;if(buttons===sent)return;
        inflight={sequence:nextSequence,operationId:crypto.randomUUID()};sent=buttons;lastSent=Date.now();
        socket.send(JSON.stringify({type:'buttons',protocol:1,...inflight,buttons}));
      }
    },16);
    void connect();
    return ()=>{mounted=false;clearTimeout(retry);clearInterval(controlsTimer);stopAuthentication?.();socket?.close();touch.current.clear();touchChanged.current=()=>{};releaseControls.current=()=>{};
      window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',release);document.removeEventListener('visibilitychange',hidden);};
  },[initial.id,attempt]);
  async function forfeit(){
    setBusy(true);setError('');
    try{const value=await api<BattleResult>(`/api/battles/${initial.id}/forfeit`,{});finished.current=true;setResult(value);setConnected(false);setConfirm(false);}
    catch(failure){setError(failure instanceof Error?failure.message:'Could not finish this battle.');}finally{setBusy(false);}
  }
  return <BattlePanel initial={initial} canvasRef={canvas} result={result} message={message} error={error} connected={connected} confirm={confirm} busy={busy}
    onExit={onExit} onReconnect={()=>setAttempt(value=>value+1)} onForfeit={()=>{controlsBlocked.current=true;releaseControls.current();setConfirm(true);}}
    onConfirm={()=>void forfeit()} onKeepPlaying={()=>setConfirm(false)}
    onControlDown={(pointer,bit)=>{touch.current.set(pointer,bit);touchChanged.current();}}
    onControlUp={pointer=>{touch.current.delete(pointer);touchChanged.current();}} />;
}

export function Battle(props:{battle:BattleView;onExit():void}){
  return httpBattles?<RequestBattle key={props.battle.id} {...props}/>:<SocketBattle key={props.battle.id} {...props}/>;
}
