import { Badge } from './components/ui/badge.tsx';
import { StatusMessage } from './components/status-message.tsx';
import { Button } from './components/ui/button.tsx';
import type { RefObject } from 'react';
import type { BattleView, LiveBattle, WatchSide } from '../../../packages/battles/protocol.ts';
import type { BattleResult } from '../../../packages/battles/session.ts';
import './battles.css';
const controls=[['↑',64],['←',32],['↓',128],['→',16],['A',1],['B',2],['Start',8],['Select',4],['L',512],['R',256]] as const;
export function BattlePanel({initial,canvasRef,result,message,error,connected,confirm,busy,canForfeit=true,onExit,onReconnect,onForfeit,onConfirm,onKeepPlaying,onControlDown,onControlUp}:{
  initial:BattleView;canvasRef:RefObject<HTMLCanvasElement|null>;result:BattleResult|null;message:string;error:string;connected:boolean;confirm:boolean;busy:boolean;
  canForfeit?:boolean;
  onExit():void;onReconnect():void;onForfeit():void;onConfirm():void;onKeepPlaying():void;onControlDown(pointer:number,bit:number):void;onControlUp(pointer:number):void;
}){
  const peer=initial.side==='a'?initial.playerB:initial.playerA;
  return <main className="game-page battle-page dark" data-version={(initial.side === 'a' ? initial.playerA : initial.playerB).version}>
    <header className="game-chrome"><div className="game-brand"><span className="game-brand-mark" aria-hidden="true"/><span>KANTO<span className="game-brand-light">ONLINE</span></span><Badge variant="outline">BATTLE</Badge></div><Badge variant="secondary">Unranked singles</Badge></header>
    <div className="game-top"><div><p className="eyebrow">LINK BATTLE</p><h1>Against @{peer.handle}</h1></div>
      {result?<Button variant="secondary" onClick={onExit}>Return to lobby</Button>:<Button variant="ghost" disabled={busy||!canForfeit} onClick={onForfeit}>Forfeit battle</Button>}</div>
    <p className="game-message" role="status">{result?result.winner===null?'The battle ended in a draw.':result.winner===initial.side?'You won the battle!':'Your opponent won the battle.':message}</p>
    <p>Singles · original levels · unranked. Your saved adventure stays ready for you.</p>
    {error&&<StatusMessage destructive className="game-error game-feedback">{error}<Button variant="outline" size="sm" onClick={onReconnect}>Reconnect</Button></StatusMessage>}
    {confirm&&!result&&<StatusMessage className="battle-confirm"><p>Forfeit this battle and return to the lobby?</p><div className="battle-confirm-actions"><Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>Confirm forfeit</Button> <Button variant="ghost" disabled={busy} onClick={onKeepPlaying}>Keep playing</Button></div></StatusMessage>}
    <canvas className="game-canvas" ref={canvasRef} width={240} height={160} aria-label="Your battle screen" />
    <div className="game-controls battle-controls">{controls.map(([label,bit])=><Button variant="secondary" key={bit} aria-label={`Battle ${label}`} disabled={!connected||Boolean(result)||confirm}
      onPointerDown={event=>{event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);onControlDown(event.pointerId,bit);}}
      onPointerUp={event=>{onControlUp(event.pointerId);}} onPointerCancel={event=>{onControlUp(event.pointerId);}}
      onLostPointerCapture={event=>{onControlUp(event.pointerId);}}>{label}</Button>)}</div>
    <p className="game-message">Arrows to move · Z / X for A / B · Enter for Start. Choose within 90 seconds; reconnect within one minute.</p>
  </main>;
}

/** Read-only spectator view. Controls, forfeit and party data are absent on
 * purpose: observers receive the rendered screen and the public result only. */
export function WatchPanel({battle,side,canvasRef,result,message,error,onExit,onSwitchSide,onReconnect}:{
  battle:LiveBattle;side:WatchSide;canvasRef:RefObject<HTMLCanvasElement|null>;result:BattleResult|null;message:string;error:string;
  onExit():void;onSwitchSide():void;onReconnect():void;
}){
  const watched=side==='a'?battle.playerA:battle.playerB,other=side==='a'?battle.playerB:battle.playerA;
  const outcome=result?result.winner===null?'The battle ended in a draw.':result.winner===side?`@${watched.handle} won the battle!`:`@${other.handle} won the battle.`:message;
  return <main className="game-page battle-page dark" data-version={watched.version}>
    <header className="game-chrome"><div className="game-brand"><span className="game-brand-mark" aria-hidden="true"/><span>KANTO<span className="game-brand-light">ONLINE</span></span><Badge variant="outline">SPECTATING</Badge></div><Badge variant="secondary">Unranked singles</Badge></header>
    <div className="game-top"><div><p className="eyebrow">LIVE BATTLE</p><h1>Watching @{watched.handle}</h1></div>
      <Button variant="secondary" onClick={onExit}>Back to lobby</Button></div>
    <p className="game-message" role="status">{outcome}</p>
    <p>@{battle.playerA.handle} vs @{battle.playerB.handle} · original levels · unranked. This view carries pixels only.</p>
    {error&&<StatusMessage destructive className="game-error game-feedback">{error}<Button variant="outline" size="sm" onClick={onReconnect}>Reconnect</Button></StatusMessage>}
    <canvas className="game-canvas" ref={canvasRef} width={240} height={160} aria-label={`Watching @${watched.handle}`} />
    <div className="lobby-toolbar">
      <Button variant="secondary" disabled={Boolean(result)} onClick={onSwitchSide}>Watch side {side==='a'?'B':'A'} · @{other.handle}</Button>
    </div>
    <p className="game-message">Read-only view. Watching never sends controls, saves or trainer data to either side.</p>
  </main>;
}
