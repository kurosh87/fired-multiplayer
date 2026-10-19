import { StatusMessage } from './components/status-message.tsx';
import { Button } from './components/ui/button.tsx';
import { Badge } from './components/ui/badge.tsx';
import { Card } from './components/ui/card.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './components/ui/dialog.tsx';
import { Kbd } from './components/ui/kbd.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip.tsx';
import { useEffect, useRef, useState } from 'react';
import { Activity, CloudCheck, Keyboard, LoaderCircle, Maximize, Minimize, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-react';
import { BrowserGameAudio } from './lib/game-audio.ts';
import { maintainSocketAuthentication } from './lib/socket-auth.ts';
import {downloadGameArtifact,prefetchGameArtifact} from './lib/game-artifact.ts';
import { api, API_URL, token } from './api.ts';
import { FRAME_MILLISECONDS, type GameVersion, type InputBatch } from '../../../packages/protocol/index.ts';
import type { SessionBootstrap } from '../../server/src/sessions.ts';
import type { TradeSceneBootstrap } from '../../server/src/trade-scenes.ts';

const keys: Record<string, number> = { KeyZ: 1, KeyX: 2, Backspace: 4, Enter: 8,
  ArrowRight: 16, ArrowLeft: 32, ArrowUp: 64, ArrowDown: 128, KeyS: 256, KeyA: 512 };

export function Game({ version, adventureId, onExit, onLobby, initialBootstrap }: { version: GameVersion; adventureId?:string; onExit: () => void;
  onLobby?: () => void; initialBootstrap?: SessionBootstrap | TradeSceneBootstrap }) {
  const trade = initialBootstrap && 'mode' in initialBootstrap && initialBootstrap.mode==='trade' ? initialBootstrap : undefined;
  const canvas = useRef<HTMLCanvasElement>(null);
  const worker = useRef<Worker | undefined>(undefined);
  const socket = useRef<WebSocket | undefined>(undefined);
  const session = useRef<SessionBootstrap | undefined>(undefined);
  const pressed = useRef(0);
  const pendingTap = useRef(0);
  const active = useRef(false);
  const exiting = useRef(false);
  const enteringLobby = useRef(false);
  const sceneFinished = useRef(Boolean(trade?.done));
  const lastAckFrame = useRef(0);
  const lastGameFrame = useRef(0);
  const progressStatus = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState('Restoring verified progress…');
  const [error, setError] = useState('');
  const [lobbyError, setLobbyError] = useState('');
  const [paused, setPaused] = useState(true);
  const [ready, setReady] = useState(false);
  const [closing, setClosing] = useState(false);
  const [tradeDone,setTradeDone] = useState(Boolean(trade?.done));
  const expectedDigests = useRef(new Map<number, string>());
  const audio=useRef<BrowserGameAudio|undefined>(undefined);
  const soundWanted=useRef(false),soundRequest=useRef(0);
  const [soundAvailable,setSoundAvailable]=useState(false);
  const [soundEnabled,setSoundEnabled]=useState(false);
  const [soundError,setSoundError]=useState('');
  const [showStats,setShowStats]=useState(true);
  const [guideOpen,setGuideOpen]=useState(false);
  const guideVisible=useRef(false);
  const [fullscreenAvailable,setFullscreenAvailable]=useState(false);
  const [fullscreen,setFullscreen]=useState(false);
  const [toolError,setToolError]=useState('');
  const [metrics,setMetrics]=useState<{fps:number|null;frameMs:number|null;speed:number|null}>({fps:null,frameMs:null,speed:null});

  useEffect(()=>{
    setFullscreenAvailable(document.fullscreenEnabled);
    const changed=()=>setFullscreen(document.fullscreenElement===document.documentElement);
    document.addEventListener('fullscreenchange',changed);
    return ()=>document.removeEventListener('fullscreenchange',changed);
  },[]);
  useEffect(()=>{
    if(paused)setMetrics({fps:ready?0:null,frameMs:null,speed:ready?0:null});
  },[paused,ready]);

  useEffect(() => {
    const playerAudio=new BrowserGameAudio();audio.current=playerAudio;
    soundWanted.current=false;soundRequest.current++;setSoundEnabled(false);setSoundAvailable(false);setSoundError('');
    const abort = new AbortController();
    let mounted = true; let animation = 0; let tickPending = false;
    let previousTime = 0; let accumulated = 0;
    let metricsAt=0,metricsRenders=0,metricsStartFrame=0;
    let stopAuthentication: (() => void) | undefined;
    function fail(text: string) {
      if (!mounted) return;
      active.current = false; exiting.current = false; setClosing(false);
      playerAudio.setPlaying(false);
      setError(existing => existing || text); setPaused(true); pressed.current = 0;pendingTap.current=0;
      setMessage('Play paused · return home to restore saved progress');
    }
    function animate(now: number) {
      if (!mounted) return;
      if (active.current) {
        accumulated += previousTime ? Math.min(now - previousTime, 100) : 0;
        // A press released before the next animation tick still gets one
        // original game frame. Do not stretch that edge over a catch-up batch.
        const frames = Math.min(Math.floor(accumulated / FRAME_MILLISECONDS), pendingTap.current&~pressed.current?1:4);
        if (frames && !tickPending) {
          if (lastGameFrame.current - lastAckFrame.current > 120 || (socket.current?.bufferedAmount ?? 0) > 65536) {
            fail('Verification is taking too long. Return home and resume your verified progress.');
            socket.current?.close();
          } else {
            let gamepadButtons = 0;
            const pad = navigator.getGamepads?.().find(item => item?.connected);
            if (pad) {
              for (const [index, bit] of [[0,1],[1,2],[4,512],[5,256],[8,4],[9,8],[12,64],[13,128],[14,32],[15,16]]) {
                if (pad.buttons[index!]?.pressed) gamepadButtons |= bit!;
              }
              if ((pad.axes[0] ?? 0) < -.4) gamepadButtons |= 32;
              if ((pad.axes[0] ?? 0) > .4) gamepadButtons |= 16;
              if ((pad.axes[1] ?? 0) < -.4) gamepadButtons |= 64;
              if ((pad.axes[1] ?? 0) > .4) gamepadButtons |= 128;
            }
            tickPending = true; accumulated -= frames * FRAME_MILLISECONDS;
            worker.current?.postMessage({ type: 'tick', buttons: pressed.current | pendingTap.current | gamepadButtons, frames });
            pendingTap.current=0;
          }
        }
        if(!metricsAt){metricsAt=now;metricsRenders=0;metricsStartFrame=lastGameFrame.current;}
        const elapsed=now-metricsAt;
        if(elapsed>=1000){
          setMetrics({fps:metricsRenders*1000/elapsed,frameMs:metricsRenders?elapsed/metricsRenders:null,
            speed:(lastGameFrame.current-metricsStartFrame)*FRAME_MILLISECONDS/elapsed*100});
          metricsAt=now;metricsRenders=0;metricsStartFrame=lastGameFrame.current;
        }
      } else {accumulated = 0;metricsAt=0;metricsRenders=0;}
      previousTime = now;
      animation = requestAnimationFrame(animate);
    }

    async function connect(bootstrap: SessionBootstrap, accessToken: string) {
      const url = new URL('/api/play', API_URL); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const connection = new WebSocket(url); socket.current = connection;
      stopAuthentication = maintainSocketAuthentication(connection, token);
      connection.onopen = () => connection.send(JSON.stringify({ type: 'authenticate', protocol: 1, token: accessToken, sessionId: bootstrap.id,
        ...(trade ? { mode:'trade',tradeId:trade.tradeId } : {}) }));
      connection.onmessage = event => {
        if (!mounted) return;
        const body = JSON.parse(event.data);
        if (body.type === 'ready' && !exiting.current) {
          if (sceneFinished.current) { playerAudio.setPlaying(false);setReady(true);setPaused(true);setMessage('Your scene is verified. Waiting for your partner to finish…');return; }
          // Time before the server resumes belongs to the paused interval.
          // Counting its last animation tick spends frames before they have
          // accrued, especially on recovery where no new jitter credit exists.
          previousTime=0; accumulated=0;
          active.current = true; worker.current?.postMessage({ type: 'resume' });
          playerAudio.setPlaying(true);
          setReady(true); setPaused(false); setMessage('Online · autosave is active');
          if(guideVisible.current){
            active.current=false;playerAudio.setPlaying(false);worker.current?.postMessage({type:'pause'});
          }
        } else if (body.type === 'verified') {
          const expected = expectedDigests.current.get(body.sequence);
          if (!expected || expected !== body.digest) {
            fail('The browser and server disagree on progress. Resume to restore the verified adventure.'); connection.close(); return;
          }
          expectedDigests.current.delete(body.sequence);
          lastAckFrame.current = body.frame;
          if (progressStatus.current) progressStatus.current.dataset.verifiedFrame = String(body.frame);
          if (!exiting.current && !enteringLobby.current && !sceneFinished.current) setMessage('Online · progress saved');
        } else if (body.type === 'paused') {
          active.current=false;pressed.current=0;pendingTap.current=0;playerAudio.setPlaying(false);
          setMessage('Paused · progress saved'); setPaused(true);
          if (trade && exiting.current) { onExit(); return; }
          if (enteringLobby.current && session.current) {
            void api(`/api/sessions/${session.current.id}/lobby`, {}).then(() => { if (mounted) onLobby?.(); }).catch(async failure => {
              if (!mounted) return;
              // A lost HTTP response can follow a committed transition and a
              // deliberately closed play socket. Recover the lobby first.
              try { await api('/api/lobby'); if (mounted) onLobby?.(); return; } catch { /* No confirmed lobby state. */ }
              if (!mounted) return;
              enteringLobby.current = false; setClosing(false);
              if (socket.current?.readyState !== WebSocket.OPEN) {
                fail('The connection stopped during lobby entry. Return home and reopen the lobby to recover saved progress.'); return;
              }
              setLobbyError(failure instanceof Error ? failure.message : 'The lobby could not open.');
            });
          }
        }
        else if (body.type === 'trade-scene-done') {
          playerAudio.setPlaying(false);
          active.current=false;pressed.current=0;pendingTap.current=0; sceneFinished.current=true; setTradeDone(true); setPaused(true);
          if (body.receipt) onExit();
          else setMessage('Your scene is verified. Waiting for your partner to finish…');
        }
        else if (body.type === 'exited') onExit();
        else if (body.type === 'error') fail(body.message);
      };
      connection.onclose = () => { if (!exiting.current && !enteringLobby.current) fail('Connection paused. Return home and resume from your last verified progress.'); };
      connection.onerror = () => fail('The game connection could not be established.');
    }

    void (async () => {
      try {
        if(!initialBootstrap)setMessage('Loading your game…');
        const prefetched=initialBootstrap?undefined:await prefetchGameArtifact(API_URL,version,abort.signal);
        if(!mounted)return;
        setMessage('Restoring verified progress…');
        const bootstrap = initialBootstrap ?? await api<SessionBootstrap>('/api/sessions', { version,...(adventureId?{adventureId}:{}) });
        if(adventureId&&bootstrap.adventureId!==adventureId)
          throw new Error('The game service returned a different adventure. Reopen your selected save.');
        session.current = bootstrap;
        const accessToken = await token();
        const [bytes, checkpoint] = await Promise.all([
          prefetched?.sha256===bootstrap.manifest.wasmSha256?Promise.resolve(prefetched.bytes)
            :downloadGameArtifact(API_URL,bootstrap.artifactUrl,bootstrap.manifest.wasmSha256,abort.signal),
          fetch(`${API_URL}${bootstrap.checkpointUrl}`, { signal: abort.signal, headers: { Authorization: `Bearer ${accessToken}` } }),
        ]);
        if (!checkpoint.ok) throw new Error('The adventure could not be downloaded.');
        const memory = await checkpoint.arrayBuffer();
        if (!mounted) return;
        const gameWorker = new Worker(new URL('./game.worker.ts', import.meta.url), { type: 'module' });
        worker.current = gameWorker;
        gameWorker.onerror = () => fail('The game worker stopped unexpectedly.');
        gameWorker.onmessage = event => {
          if (!mounted) return;
          const body = event.data;
          if (body.type === 'booted') {
            setSoundAvailable(body.audioAvailable===true);
            gameWorker.postMessage({type:'audio',enabled:soundWanted.current});
            lastAckFrame.current = body.frame; lastGameFrame.current = body.frame;
            void connect(bootstrap, accessToken);
          } else if (body.type === 'frame') {
            tickPending = false; lastGameFrame.current = body.frame;
            const context=canvas.current?.getContext('2d');
            if(context){context.putImageData(new ImageData(new Uint8ClampedArray(body.pixels), 240, 160), 0, 0);if(active.current)metricsRenders++;}
          } else if (body.type === 'batch') {
            const batch = body.batch as InputBatch;
            expectedDigests.current.set(batch.sequence, body.digest);
            if (socket.current?.readyState !== WebSocket.OPEN) { fail('The game connection was lost.'); return; }
            socket.current.send(JSON.stringify(batch));
          } else if (body.type === 'trade-done') {
            playerAudio.setPlaying(false);
            active.current=false; pressed.current=0;pendingTap.current=0; sceneFinished.current=true; setTradeDone(true); setPaused(true);
            setMessage('Finishing verification and waiting for your partner…');
          } else if(body.type==='audio-reset'){playerAudio.reset();
          } else if(body.type==='audio'){
            if(active.current){try{playerAudio.enqueue(body);}catch{
              soundWanted.current=false;setSoundEnabled(false);void playerAudio.setEnabled(false);
              gameWorker.postMessage({type:'audio',enabled:false});setSoundError('Sound stopped. You can keep playing and try Sound again.');
            }}
          } else if (body.type === 'paused') socket.current?.send(JSON.stringify({ type: exiting.current && !trade ? 'exit' : 'pause' }));
          else if (body.type === 'error') fail(body.message);
        };
        gameWorker.postMessage({ type: 'boot', bytes, checkpoint: memory, manifest: bootstrap.manifest,
          sessionId: bootstrap.id, seed: bootstrap.seed, sequence: bootstrap.nextSequence, digest: bootstrap.digest, ...(trade ? { mode:'trade' } : {}) }, [bytes, memory]);
        animation = requestAnimationFrame(animate);
      } catch (failure) { if (mounted) fail(failure instanceof Error ? failure.message : 'The adventure could not start.'); }
    })();

    const keydown = (event: KeyboardEvent) => {
      if(guideVisible.current)return;
      if(event.target instanceof HTMLButtonElement&&['Enter','Space'].includes(event.code))return;
      const bit = keys[event.code]; if (bit) { event.preventDefault();if(active.current){pressed.current |= bit;pendingTap.current|=bit;} }
    };
    const keyup = (event: KeyboardEvent) => { const bit = keys[event.code]; if (bit) { event.preventDefault(); pressed.current &= ~bit; } };
    const background = () => {
      pressed.current = 0;pendingTap.current=0;
      if (document.hidden && active.current) { active.current = false; playerAudio.setPlaying(false);worker.current?.postMessage({ type: 'pause' }); }
    };
    window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup);
    document.addEventListener('visibilitychange', background);
    window.addEventListener('blur', background);
    return () => {
      mounted = false; active.current = false; pressed.current = 0;pendingTap.current=0;
      soundRequest.current++;playerAudio.dispose();if(audio.current===playerAudio)audio.current=undefined;
      abort.abort(); cancelAnimationFrame(animation); stopAuthentication?.(); worker.current?.terminate(); socket.current?.close();
      window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup);
      document.removeEventListener('visibilitychange', background); window.removeEventListener('blur', background);
    };
  }, [version, adventureId, initialBootstrap]);

  useEffect(() => {
    if (!trade || !tradeDone) return;
    let current=true;
    const check=()=>void api<{done:boolean;receipt?:unknown}>(`/api/trades/${trade.tradeId}/finish`,{}).then(result=> {
      if (current && result.receipt) onExit();
    }).catch(failure=> { if (current) setError(failure.message); });
    const timer=setInterval(check,3000);
    return ()=>{current=false;clearInterval(timer);};
  },[trade?.tradeId,tradeDone]);

  function pauseOrResume() {
    if (!ready || error || guideVisible.current) return;
    setLobbyError('');
    if (active.current) { active.current = false; audio.current?.setPlaying(false);pressed.current = 0;pendingTap.current=0; worker.current?.postMessage({ type: 'pause' }); }
    else { audio.current?.resume();socket.current?.send(JSON.stringify({ type: 'resume' })); }
    canvas.current?.focus();
  }
  function openGuide(open:boolean){
    guideVisible.current=open;setGuideOpen(open);pressed.current=0;pendingTap.current=0;
    if(open&&active.current){
      active.current=false;audio.current?.setPlaying(false);worker.current?.postMessage({type:'pause'});
    }
  }
  async function toggleFullscreen(){
    setToolError('');
    try{
      if(document.fullscreenElement===document.documentElement)await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    }catch{setToolError('Fullscreen is unavailable. You can keep playing in this window.');}
  }
  function toggleSound(){
    const playerAudio=audio.current;if(!playerAudio||!soundAvailable||!ready)return;
    const wanted=!soundWanted.current,request=++soundRequest.current;
    soundWanted.current=wanted;setSoundEnabled(wanted);setSoundError('');
    worker.current?.postMessage({type:'audio',enabled:wanted});
    void playerAudio.setEnabled(wanted).catch(()=>{
      if(audio.current!==playerAudio||soundRequest.current!==request)return;
      soundWanted.current=false;setSoundEnabled(false);worker.current?.postMessage({type:'audio',enabled:false});
      setSoundError('Sound could not start. Try Sound again when you are ready.');
    });
  }
  function enterLobby() {
    if (!ready || error || closing || !onLobby) return;
    active.current = false; pressed.current = 0;pendingTap.current=0; enteringLobby.current = true;
    audio.current?.setPlaying(false);
    setClosing(true); setLobbyError(''); setMessage('Saving your adventure before opening the lobby…');
    // The worker seals its last batch before sending pause over the same
    // websocket. Enter only after the server's durable pause acknowledgement.
    worker.current?.postMessage({ type: 'pause' });
  }
  async function exit() {
    active.current = false; pressed.current = 0;pendingTap.current=0;
    audio.current?.setPlaying(false);
    if (error || tradeDone) { onExit(); return; }
    if (socket.current?.readyState === WebSocket.OPEN && worker.current) {
      exiting.current = true; setClosing(true); setMessage('Saving your adventure before leaving…');
      worker.current.postMessage({ type: 'pause' });
      return;
    }
    try {
      if (session.current) await api(`/api/sessions/${session.current.id}/exit`, {});
      onExit();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The checkpoint could not be saved.');
    }
  }
  async function cancelTrade() {
    if (!trade) return;
    active.current=false; pressed.current=0;pendingTap.current=0; setClosing(true);
    audio.current?.setPlaying(false);
    try { await api(`/api/trades/${trade.tradeId}/cancel`,{}); onExit(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The trade could not be cancelled.'); setClosing(false); }
  }
  const control = (label: string, bit: number, direction?: string) => <Button variant="secondary" key={label} data-direction={direction} aria-label={label}
    onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);if(active.current){pressed.current |= bit;pendingTap.current|=bit;} }}
    onPointerUp={() => { pressed.current &= ~bit; }} onPointerCancel={() => { pressed.current &= ~bit;pendingTap.current&=~bit; }} onLostPointerCapture={() => { pressed.current &= ~bit; }}>{label}</Button>;
  const ProgressIcon = error ? WifiOff : closing || !ready ? LoaderCircle : paused ? CloudCheck : Wifi;
  const progressLabel = error ? 'Play paused' : closing ? 'Saving' : !ready ? 'Connecting' : tradeDone ? 'Finishing trade' : paused ? 'Saved' : 'Online';

  return <TooltipProvider delayDuration={250}><main className="game-page dark" data-version={version}>
    <header className="game-chrome">
      <div className="game-brand"><span className="game-brand-mark" aria-hidden="true"/><span>KANTO<span className="game-brand-light">ONLINE</span></span><Badge variant="outline">{trade?'TRADE':'ADVENTURE'}</Badge></div>
      <nav className="game-chrome-tools" aria-label="Player tools">
        <Dialog open={guideOpen} onOpenChange={openGuide}>
          <DialogTrigger asChild><Button variant="ghost" aria-label="Controls"><Keyboard aria-hidden="true"/><span>Controls</span></Button></DialogTrigger>
          <DialogContent className="dark game-guide" data-version={version}>
            <DialogHeader><DialogTitle>Your keyboard is a controller, too.</DialogTitle><DialogDescription>Opening this guide pauses play. Close it and choose Resume when you are ready.</DialogDescription></DialogHeader>
            <dl><div><dt>Move</dt><dd><Kbd>↑</Kbd><Kbd>←</Kbd><Kbd>↓</Kbd><Kbd>→</Kbd></dd></div><div><dt>A / B</dt><dd><Kbd>Z</Kbd><Kbd>X</Kbd></dd></div><div><dt>Start / Select</dt><dd><Kbd>Enter</Kbd><Kbd>Backspace</Kbd></dd></div><div><dt>L / R</dt><dd><Kbd>A</Kbd><Kbd>S</Kbd></dd></div></dl>
          </DialogContent>
        </Dialog>
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" aria-label="Stats" aria-pressed={showStats} onClick={()=>setShowStats(value=>!value)}><Activity aria-hidden="true"/><span>Stats</span></Button></TooltipTrigger><TooltipContent>Toggle performance overlay</TooltipContent></Tooltip>
        {fullscreenAvailable&&<Tooltip><TooltipTrigger asChild><Button variant="ghost" aria-label={fullscreen?'Exit fullscreen':'Enter fullscreen'} onClick={()=>void toggleFullscreen()}>{fullscreen?<Minimize aria-hidden="true"/>:<Maximize aria-hidden="true"/>}<span>Fullscreen</span></Button></TooltipTrigger><TooltipContent>Toggle fullscreen</TooltipContent></Tooltip>}
      </nav>
    </header>
    <div className="game-top"><Button variant="secondary" onClick={() => void exit()} disabled={closing}>{closing ? 'Saving…' : trade ? '← Back to lobby' : error ? '← Back home' : '← Save & exit'}</Button><h1>{trade ? 'Trading · ' : ''}{version === 'firered' ? 'FireRed' : 'LeafGreen'}</h1><div className="game-tools"><Button variant="outline" aria-label={soundEnabled?'Mute sound':'Enable sound'} aria-pressed={soundEnabled} onClick={toggleSound} disabled={!soundAvailable||!ready||Boolean(error)||closing||tradeDone}>{soundEnabled?<Volume2 aria-hidden="true"/>:<VolumeX aria-hidden="true"/>}Sound</Button><Button variant="secondary" onClick={pauseOrResume} disabled={!ready || Boolean(error) || closing || tradeDone}>{paused ? 'Resume' : 'Pause & checkpoint'}</Button></div></div>
    <div className="game-progress"><Badge variant="outline" className="game-progress-badge"><ProgressIcon aria-hidden="true" className={closing || !ready && !error ? 'animate-spin' : undefined}/>{progressLabel}</Badge><div className="game-message" ref={progressStatus} data-verified-frame="0" role="status">{message}</div></div>{error && <StatusMessage destructive className="game-error game-feedback">{error}</StatusMessage>}
    {lobbyError && <StatusMessage destructive className="game-error game-feedback">{lobbyError}</StatusMessage>}
    {soundError&&<p className="game-message" aria-live="polite">{soundError}</p>}
    {toolError&&<p className="game-message" aria-live="polite">{toolError}</p>}
    {trade && <div className="lobby-toolbar"><p>Both saves update after both scenes finish. Use the game controls for evolution and move choices.</p><Button variant="outline" size="sm" onClick={()=>void cancelTrade()} disabled={closing}>Cancel trade</Button></div>}
    {onLobby && <Button className="lobby-entry" onClick={enterLobby} disabled={!ready || Boolean(error) || closing}>Enter online lobby</Button>}
    <div className="game-screen-wrap"><canvas ref={canvas} className="game-canvas" width={240} height={160} tabIndex={0} aria-label="Game screen" />
      <Card className="game-performance" role="region" aria-label="Performance overlay" hidden={!showStats} title="FPS counts canvas updates. Speed compares simulation time with elapsed time; these are browser measurements.">
        <span><b data-metric="fps">{metrics.fps===null?'—':Math.round(metrics.fps)}</b><small>FPS</small></span><span><b data-metric="interval">{metrics.frameMs===null?'—':metrics.frameMs.toFixed(1)}</b><small>MS / FRAME</small></span><span><b data-metric="speed">{metrics.speed===null?'—':`${Math.round(metrics.speed)}%`}</b><small>SPEED</small></span>
      </Card>
    </div>
    <div className="game-controls"><div className="dpad">{control('↑',64,'up')}{control('←',32,'left')}{control('→',16,'right')}{control('↓',128,'down')}</div><div className="system-buttons">{control('L',512)}{control('SELECT',4)}{control('START',8)}{control('R',256)}</div><div className="action-buttons">{control('B',2)}{control('A',1)}</div></div>
    <p className="game-message">Keyboard: arrows · Z / X · Enter / Backspace · A / S</p>
  </main></TooltipProvider>;
}
