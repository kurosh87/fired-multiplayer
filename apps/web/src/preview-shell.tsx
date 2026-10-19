import { Alert } from './components/ui/alert.tsx';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Activity, Cloud, CloudOff, Keyboard, Maximize, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { PreviewAccount } from './preview-account.tsx';
import { Button } from './components/ui/button.tsx';
import { Badge } from './components/ui/badge.tsx';
import { Card } from './components/ui/card.tsx';
import { Kbd } from './components/ui/kbd.tsx';
import { Separator } from './components/ui/separator.tsx';
import { Label } from './components/ui/label.tsx';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.tsx';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from './components/ui/dialog.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip.tsx';
import './theme.css';
import './engine-preview.css';

declare const __KANTO_STATIC_PREVIEW__: boolean;
const hosted = typeof __KANTO_STATIC_PREVIEW__ !== 'undefined' && __KANTO_STATIC_PREVIEW__;
declare const __KANTO_NETLIFY_ACCOUNTS__: boolean;
const accounts = typeof __KANTO_NETLIFY_ACCOUNTS__ !== 'undefined' && __KANTO_NETLIFY_ACCOUNTS__;

function RestartPreviewDialog() {
  const [open, setOpen] = useState(false);
  const [edition, setEdition] = useState('FireRed');
  useEffect(() => {
    const request = () => {
      window.dispatchEvent(new Event('kanto-preview-pause'));
      setEdition(document.querySelector<HTMLSelectElement>('#version')?.value === 'leafgreen' ? 'LeafGreen' : 'FireRed');
      setOpen(true);
    };
    window.addEventListener('kanto-preview-restart-request', request);
    return () => window.removeEventListener('kanto-preview-restart-request', request);
  }, []);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogContent id="restart-preview" className="restart-dialog" onCloseAutoFocus={event => { event.preventDefault(); document.getElementById('start')?.focus(); }}>
      <DialogHeader><DialogTitle>Restart preview?</DialogTitle><DialogDescription>Start {edition} from the beginning. Your current preview progress will be cleared.</DialogDescription></DialogHeader>
      <p className="restart-note">Cancel keeps your adventure paused. Choose Resume when you’re ready.</p>
      <DialogFooter><DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose><Button variant="destructive" onClick={() => { setOpen(false); window.dispatchEvent(new Event('kanto-preview-restart-confirm')); }}><RotateCcw aria-hidden="true" />Restart adventure</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function PreviewShell() {
  return <TooltipProvider delayDuration={250}><Dialog onOpenChange={open => { if (open) window.dispatchEvent(new Event('kanto-preview-pause')); }}>
<>
<header className="chrome">
      <a className="brand" href="/" aria-label="Kanto Online home"><span className="brand-mark" aria-hidden="true"></span><span>KANTO<span className="brand-sub">ONLINE</span></span></a>
      <Badge variant="outline" className="preview-badge">PREVIEW</Badge>
      <Separator orientation="vertical" className="chrome-divider" />
      <nav aria-label="Player tools">
        {accounts && <PreviewAccount />}
        <Tooltip><TooltipTrigger asChild><Button id="sound-toggle" aria-label="Enable sound" variant="ghost" className="tool" aria-pressed="false" disabled><Volume2 className="sound-on" aria-hidden="true" /><VolumeX className="sound-off" aria-hidden="true" /><span>Sound</span></Button></TooltipTrigger><TooltipContent>Toggle game sound</TooltipContent></Tooltip>
        <DialogTrigger asChild><Button id="help-toggle" aria-label="Controls" variant="ghost" className="tool"><Keyboard aria-hidden="true" /><span>Controls</span></Button></DialogTrigger>
        <Tooltip><TooltipTrigger asChild><Button id="stats-toggle" aria-label="Stats" variant="ghost" className="tool" aria-pressed="true"><Activity aria-hidden="true" /><span>Stats</span></Button></TooltipTrigger><TooltipContent>Toggle performance overlay</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button id="fullscreen" variant="ghost" className="tool" aria-label="Enter fullscreen"><Maximize aria-hidden="true" /><span className="fullscreen-label">Fullscreen</span></Button></TooltipTrigger><TooltipContent>Toggle fullscreen</TooltipContent></Tooltip>
      </nav>
    </header>
    <main>
      <div className="heading"><div><div className="tag">{hosted ? 'Browser gameplay preview' : 'Local development preview'}</div><h1>A little Kanto. Anywhere.</h1></div><Badge variant="secondary" className="session-label"><i aria-hidden="true" />SOLO PLAY</Badge></div>
      <Card className="player gap-0 py-0" role="region" aria-label="Game player">
        <div className="player-toolbar">
          <Label className="version-select"><span className="edition-dot"></span><span className="sr-only">Game</span><NativeSelect id="version" aria-label="Game" onChange={event => { document.body.dataset.version = event.currentTarget.value; }}><NativeSelectOption value="firered">FireRed</NativeSelectOption><NativeSelectOption value="leafgreen">LeafGreen</NativeSelectOption></NativeSelect></Label>
          <span className="edition-note">GAME BOY ADVANCE</span>
          <div className="launch-controls"><Button variant="outline" id="pause" className="pause-button" disabled>Pause</Button><Button id="start" className="primary" disabled>Start preview</Button></div>
        </div>
        <div className="screen-wrap" id="screen-wrap">
          <canvas id="game" width={240} height={160} tabIndex={0} aria-label="Game screen"></canvas>
          <div id="screen-message" className="screen-message"><span className="screen-emblem" aria-hidden="true">✦</span><strong id="screen-title">Ready when you are.</strong><span id="screen-hint">Choose your edition and start an adventure.</span></div>
          <Card id="performance" className="performance flex-row gap-3 py-2" aria-label="Performance overlay" title="FPS counts canvas updates; speed measures simulated game frames per second.">
            <span><b id="fps-value">—</b><small>FPS</small></span><span><b id="frame-time">—</b><small>MS / FRAME</small></span><span><b id="speed-value">—</b><small>SPEED</small></span>
          </Card>
          <div className="screen-bottom"><span id="play-state" data-state="ready">READY</span><span>FRAME <b id="frame-value">000000</b></span></div>
        </div>
        <div className="controls" aria-label="Game controls">
          <div className="dpad"><span className="dpad-center" aria-hidden="true"></span><Button variant="secondary" data-button="64" aria-label="Up">▲</Button><Button variant="secondary" data-button="32" aria-label="Left">◀</Button><Button variant="secondary" data-button="16" aria-label="Right">▶</Button><Button variant="secondary" data-button="128" aria-label="Down">▼</Button></div>
          <div className="system"><div className="shoulders"><Button variant="secondary" data-button="512" aria-label="L shoulder">L</Button><Button variant="secondary" data-button="256" aria-label="R shoulder">R</Button></div><div className="system-main"><Button variant="secondary" data-button="4">SELECT</Button><Button variant="secondary" data-button="8">START</Button></div><span className="controller-note">YOUR NEXT CHAPTER AWAITS</span></div>
          <div className="actions"><div><Button variant="secondary" data-button="2">B</Button><span>CANCEL</span></div><div><Button variant="secondary" data-button="1">A</Button><span>CONFIRM</span></div></div>
        </div>
        <div className="preview-progress"><Badge variant="outline">{accounts ? <><Cloud aria-hidden="true" />Account saves</> : <><CloudOff aria-hidden="true" />Session only</>}</Badge><p>{accounts ? 'Use SAVE in the game menu, then Account → Sync current game save. Reloading clears unsynced progress.' : 'Progress stays in this open page. Reloading or restarting clears it.'}</p></div>
      </Card>
      <div className="status-bar"><div id="status" role="status">Choose a game to start.</div><span>240 × 160 · ORIGINAL RESOLUTION</span></div>
      <Alert id="error" className="block" hidden />
      <DialogContent id="keyboard-guide" className="keyboard-guide sm:max-w-xl">
        <DialogHeader><DialogTitle>Make yourself at home.</DialogTitle><DialogDescription>Your keyboard is a controller, too.</DialogDescription></DialogHeader>
        <dl><div><dt>Move</dt><dd><Kbd className="keycap">↑</Kbd><Kbd className="keycap">←</Kbd><Kbd className="keycap">↓</Kbd><Kbd className="keycap">→</Kbd></dd></div><div><dt>A / B</dt><dd><Kbd className="keycap">Z</Kbd><Kbd className="keycap">X</Kbd></dd></div><div><dt>Start / Select</dt><dd><Kbd className="keycap">Enter</Kbd><Kbd className="keycap">Backspace</Kbd></dd></div><div><dt>L / R</dt><dd><Kbd className="keycap">A</Kbd><Kbd className="keycap">S</Kbd></dd></div></dl>
      </DialogContent>
      <RestartPreviewDialog />
      <footer><p>{hosted ? 'Experimental browser play.' : 'Experimental local play.'} {accounts ? 'Account saves are for solo play. Battles and trades are under development.' : 'Account saves and multiplayer are still being integrated.'}</p><span className="footer-mark">KANTO / 001</span></footer>
    </main>
</></Dialog></TooltipProvider>;
}

flushSync(() => createRoot(document.getElementById('root')!).render(<PreviewShell />));
void import('./engine-preview.ts');
