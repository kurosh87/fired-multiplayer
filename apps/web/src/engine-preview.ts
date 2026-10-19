import { FRAME_MILLISECONDS, type GameVersion } from '../../../packages/protocol/index.ts';
import { BrowserGameAudio } from './lib/game-audio.ts';
import { downloadGameArtifact } from './lib/game-artifact.ts';

declare const __KANTO_STATIC_PREVIEW__: boolean;
const hosted = typeof __KANTO_STATIC_PREVIEW__ !== 'undefined' && __KANTO_STATIC_PREVIEW__;

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const context = canvas.getContext('2d')!;
const start = document.querySelector<HTMLButtonElement>('#start')!;
const pause = document.querySelector<HTMLButtonElement>('#pause')!;
const version = document.querySelector<HTMLSelectElement>('#version')!;
const status = document.querySelector<HTMLElement>('#status')!;
const error = document.querySelector<HTMLElement>('#error')!;
const playState = document.querySelector<HTMLElement>('#play-state')!;
const screenMessage = document.querySelector<HTMLElement>('#screen-message')!;
const screenTitle = document.querySelector<HTMLElement>('#screen-title')!;
const screenHint = document.querySelector<HTMLElement>('#screen-hint')!;
const fpsValue = document.querySelector<HTMLElement>('#fps-value')!;
const frameTime = document.querySelector<HTMLElement>('#frame-time')!;
const speedValue = document.querySelector<HTMLElement>('#speed-value')!;
const frameValue = document.querySelector<HTMLElement>('#frame-value')!;
const controls = [...document.querySelectorAll<HTMLButtonElement>('[data-button]')];
const keys: Record<string, number> = { KeyZ: 1, KeyX: 2, Backspace: 4, Enter: 8,
  ArrowRight: 16, ArrowLeft: 32, ArrowUp: 64, ArrowDown: 128, KeyS: 256, KeyA: 512 };
let worker: Worker | undefined;
let download: AbortController | undefined;
let runningAdventureId: string | undefined;
let runningVersion: GameVersion | undefined, gameOwner: string | undefined, currentAccount: string | undefined;
const flashRequests = new Map<string, GameVersion>();
let active = false, pending = false, buttons = 0, pressed = 0, previousTime = 0, accumulated = 0;
let bootSerial = 0;
const audio=new BrowserGameAudio();
const soundToggle=document.querySelector<HTMLButtonElement>('#sound-toggle')!;
let soundEnabled=false;
let soundRequest=0;
function updateSound(){
  soundToggle.setAttribute('aria-pressed',String(soundEnabled));soundToggle.setAttribute('aria-label',soundEnabled?'Mute sound':'Enable sound');
}
soundToggle.addEventListener('click',()=>{
  const request=++soundRequest;
  soundEnabled=!soundEnabled;updateSound();worker?.postMessage({type:'audio',enabled:soundEnabled});
  void audio.setEnabled(soundEnabled).catch(()=>{if(request!==soundRequest)return;soundEnabled=false;updateSound();worker?.postMessage({type:'audio',enabled:false});status.textContent='Sound could not start. Tap Sound to try again.';});
});
let metricsAt = 0, metricsRenders = 0, metricsStartFrame = 0, latestFrame = 0;
function resetMetrics() {
  metricsAt = performance.now(); metricsRenders = 0; metricsStartFrame = latestFrame;
  fpsValue.textContent = '—'; frameTime.textContent = '—'; speedValue.textContent = '—';
}
function showState(state: 'ready' | 'loading' | 'playing' | 'paused' | 'error') {
  playState.dataset.state = state; playState.textContent = state.toUpperCase();
  screenMessage.hidden = state === 'playing'; screenMessage.classList.toggle('paused', state === 'paused');
  const messages = { ready: ['Ready when you are.', 'Choose your edition and start an adventure.'],
    loading: ['Packing your adventure…', 'Preparing the game. Just a moment.'],
    paused: ['Take your time.', 'Press Resume when you’re ready.'],
    error: ['Let’s try that again.', 'Restart the preview to get back to Kanto.'], playing: ['', ''] };
  [screenTitle.textContent, screenHint.textContent] = messages[state] as [string, string];
  if (state !== 'playing') { fpsValue.textContent = state === 'paused' ? '0' : '—'; frameTime.textContent = '—'; speedValue.textContent = '—'; }
}
function updateControlFeedback() {
  for (const control of controls) control.classList.toggle('is-pressed', (buttons & Number(control.dataset.button)) !== 0);
}
const statsToggle = document.querySelector<HTMLButtonElement>('#stats-toggle')!;
statsToggle.addEventListener('click', () => {
  const show = statsToggle.getAttribute('aria-pressed') !== 'true';
  statsToggle.setAttribute('aria-pressed', String(show));
  document.querySelector<HTMLElement>('#performance')!.hidden = !show;
});
const fullscreen = document.querySelector<HTMLButtonElement>('#fullscreen')!;
fullscreen.hidden = !document.fullscreenEnabled;
fullscreen.addEventListener('click', () => {
  const action = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  void action.catch(() => { status.textContent = 'Fullscreen is unavailable in this browser.'; });
});
document.addEventListener('fullscreenchange', () => {
  fullscreen.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen');
  fullscreen.querySelector('.fullscreen-label')!.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
});
function fail(message: string) {
  audio.setPlaying(false);soundToggle.disabled=true;
  active = false; buttons = 0; pressed = 0; pause.disabled = true; start.disabled = false; version.disabled = false;
  worker?.terminate(); worker = undefined; pending = false;
  error.hidden = false; error.textContent = message; status.textContent = 'Preview stopped.';
  showState('error'); updateControlFeedback();
}
async function checked(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? (hosted ? 'The preview could not download. Please reload and try again.' : 'Start this page with npm run engine:preview and build both candidates first.'));
  }
  return response;
}
function bootPreview(saved?: { flash?: ArrayBuffer; version: GameVersion; owner: string; adventureId?: string }) {
  if (saved) version.value = saved.version;
  for (const requestId of flashRequests.keys()) window.dispatchEvent(new CustomEvent('kanto-preview-flash-result', { detail: { requestId, error: 'The game restarted before its save was ready.' } }));
  flashRequests.clear(); runningVersion = version.value as GameVersion; gameOwner = saved?.owner ?? currentAccount;
  runningAdventureId = saved?.adventureId;
  const serial = ++bootSerial;
  download?.abort(); const controller = new AbortController(); download = controller;
  active = false; buttons = 0; pressed = 0; pending = false; worker?.terminate();
  audio.setPlaying(false);audio.reset();audio.resume();soundToggle.disabled=true;
  start.disabled = true; version.disabled = true; pause.disabled = true; error.hidden = true;
  status.textContent = 'Loading the original game engine…';
  showState('loading'); updateControlFeedback(); latestFrame = 0; frameValue.textContent = '000000'; resetMetrics();
  document.body.dataset.version = version.value;
  void (async () => {
    const metadata = await (await checked(hosted ? `/preview-data/${version.value}/boot.json` : `/__engine-preview/${version.value}/boot`)).json();
    if (serial !== bootSerial) return;
    if (hosted && (metadata.manifest?.version !== version.value || !/^[a-f0-9]{64}$/.test(metadata.manifest?.wasmSha256)
      || metadata.artifactUrl !== `/preview-data/${version.value}/${metadata.manifest.wasmSha256}.wasm`)) throw new Error('The game download is unavailable. Please reload.');
    const [bytes, checkpoint] = await Promise.all([
      hosted ? downloadGameArtifact('', metadata.artifactUrl, metadata.manifest.wasmSha256, controller.signal)
        : checked(metadata.artifactUrl).then(response => response.arrayBuffer()),
      saved?.flash ? Promise.resolve(undefined) : checked(metadata.checkpointUrl).then(response => response.arrayBuffer()),
    ]);
    if (serial !== bootSerial) return;
    const gameWorker = new Worker(new URL('./game.worker.ts', import.meta.url), { type: 'module' });
    worker = gameWorker;
    gameWorker.onerror = () => fail('The game worker stopped unexpectedly. Restart the preview.');
    gameWorker.onmessage = ({ data }) => {
      if (gameWorker !== worker) return;
      if (data.type === 'booted') {
        soundToggle.disabled=!data.audioAvailable;audio.setPlaying(true);
        gameWorker.postMessage({type:'audio',enabled:soundEnabled});
        active = true; previousTime = 0; accumulated = 0;
        start.disabled = false; version.disabled = false; pause.disabled = false;
        start.textContent = 'Restart preview'; pause.textContent = 'Pause';
        status.textContent = `${metadata.manifest.version === 'firered' ? 'FireRed' : 'LeafGreen'} · ${hosted ? 'browser' : 'local'} preview`;
        showState('playing'); resetMetrics();
        gameWorker.postMessage({ type: 'resume' });
        if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) pauseGame();
        else canvas.focus();
      } else if (data.type === 'frame') {
        pending = false;
        canvas.dataset.frame = String(data.frame);
        latestFrame = data.frame; metricsRenders++;
        frameValue.textContent = String(data.frame).padStart(6, '0');
        context.putImageData(new ImageData(new Uint8ClampedArray(data.pixels), 240, 160), 0, 0);
      } else if (data.type === 'flash') {
        const edition = flashRequests.get(data.requestId); flashRequests.delete(data.requestId);
        if (edition) window.dispatchEvent(new CustomEvent('kanto-preview-flash-result', { detail: { requestId: data.requestId, flash: data.flash, version: edition, adventureId: runningAdventureId, bootId: serial } }));
      } else if(data.type==='audio-reset'){audio.reset();
      } else if(data.type==='audio'){
        try{audio.enqueue(data);const stats=audio.stats;soundToggle.dataset.packets=String(stats.packets);soundToggle.dataset.nonSilentPackets=String(stats.nonSilentPackets);soundToggle.dataset.queuedSeconds=String(stats.queuedSeconds);}
        catch{soundEnabled=false;updateSound();void audio.setEnabled(false);gameWorker.postMessage({type:'audio',enabled:false});status.textContent='Sound stopped. You can keep playing and try Sound again.';}
      } else if (data.type === 'error') fail(data.message);
      // Input batches are intentionally not submitted as verified progress.
      // Preview flash sync is separate from the authoritative multiplayer journal.
    };
    if (saved?.flash) gameWorker.postMessage({ type: 'preview-boot', bytes, flash: saved.flash, manifest: metadata.manifest,
      seed: metadata.seed, sessionId: 'cloud-unverified-preview', sequence: 0 }, [bytes, saved.flash]);
    else gameWorker.postMessage({ type: 'boot', bytes, checkpoint: checkpoint!, manifest: metadata.manifest,
      seed: metadata.seed, sessionId: 'local-unverified-preview', sequence: 0, digest: metadata.digest, journal: false }, [bytes, checkpoint!]);
  })().catch(failure => { if (serial === bootSerial) fail(failure instanceof Error ? failure.message : 'Preview could not start.'); });
}
start.addEventListener('click', () => {
  if (worker) window.dispatchEvent(new Event('kanto-preview-restart-request'));
  else bootPreview();
});
window.addEventListener('kanto-preview-restart-confirm', () => bootPreview());
window.addEventListener('kanto-preview-account-changed', event => {
  currentAccount = (event as CustomEvent).detail.owner;
  if (gameOwner && gameOwner !== currentAccount) pauseGame();
});
window.addEventListener('kanto-preview-export-flash', event => {
  const { requestId, owner } = (event as CustomEvent).detail;
  pauseGame();
  const message = !worker || !runningVersion ? 'Start an adventure before syncing a save.'
    : gameOwner && gameOwner !== owner ? 'This adventure belongs to the previous account. Load your own cloud save or restart the preview.' : undefined;
  if (message) { window.dispatchEvent(new CustomEvent('kanto-preview-flash-result', { detail: { requestId, error: message } })); return; }
  gameOwner = owner; flashRequests.set(requestId, runningVersion!); worker!.postMessage({ type: 'export-flash', requestId });
});
window.addEventListener('kanto-preview-load-save', event => {
  const saved = (event as CustomEvent).detail;
  if (!saved || (saved.flash !== undefined && (!(saved.flash instanceof ArrayBuffer) || saved.flash.byteLength !== 131072))
    || !['firered', 'leafgreen'].includes(saved.version) || saved.owner !== currentAccount) return;
  bootPreview(saved);
});
window.addEventListener('kanto-preview-bind-adventure', event => {
  const selected = (event as CustomEvent).detail;
  if (selected?.owner === currentAccount && selected.owner === gameOwner && selected.version === runningVersion
    && selected.bootId === bootSerial && worker) runningAdventureId = selected.adventureId;
});
function pauseGame() {
  if (!active) return;
  active = false; buttons = 0; pressed = 0; accumulated = 0;
  audio.setPlaying(false);
  worker?.postMessage({ type: 'pause' }); pause.textContent = 'Resume';
  showState('paused'); updateControlFeedback();
}
pause.onclick = () => {
  if (active) pauseGame();
  else { active = true; previousTime = 0; accumulated = 0; audio.resume();audio.setPlaying(true);worker?.postMessage({ type: 'resume' }); pause.textContent = 'Pause'; showState('playing'); resetMetrics(); }
  canvas.focus();
};
function animate(now: number) {
  if (active) {
    const elapsed = now - metricsAt;
    if (elapsed >= 500) {
      const fps = metricsRenders * 1000 / elapsed;
      fpsValue.textContent = String(Math.round(fps));
      frameTime.textContent = fps > 0 ? (1000 / fps).toFixed(1) : '—';
      speedValue.textContent = (((latestFrame - metricsStartFrame) * FRAME_MILLISECONDS) / elapsed).toFixed(2) + '×';
      metricsAt = now; metricsRenders = 0; metricsStartFrame = latestFrame;
    }
    accumulated = Math.min(accumulated + (previousTime ? now - previousTime : 0), 4 * FRAME_MILLISECONDS);
    const frames = Math.min(4, Math.floor(accumulated / FRAME_MILLISECONDS));
    if (frames && !pending) {
      pending = true; accumulated -= frames * FRAME_MILLISECONDS;
      worker?.postMessage({ type: 'tick', buttons: buttons | pressed, frames });
      pressed = 0;
    }
  }
  previousTime = now; requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
window.addEventListener('keydown', event => {
  if (!active || event.target instanceof HTMLSelectElement || (event.target instanceof HTMLButtonElement && ['Enter', 'Space'].includes(event.code))) return;
  const bit = keys[event.code]; if (bit) { event.preventDefault(); buttons |= bit; if (!event.repeat) pressed |= bit; }
  updateControlFeedback();
});
window.addEventListener('keyup', event => { const bit = keys[event.code]; if (bit) { event.preventDefault(); buttons &= ~bit; updateControlFeedback(); } });
window.addEventListener('blur', () => { buttons = 0; pauseGame(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });
for (const control of controls) {
  const bit = Number(control.dataset.button);
  control.onpointerdown = event => { event.preventDefault(); if (!active) return; control.setPointerCapture(event.pointerId); buttons |= bit; pressed |= bit; updateControlFeedback(); };
  control.onpointerup = control.onpointercancel = control.onlostpointercapture = () => { buttons &= ~bit; updateControlFeedback(); };
}

window.addEventListener('kanto-preview-pause', pauseGame);
window.addEventListener('pagehide',()=>{download?.abort();soundEnabled=false;soundRequest++;updateSound();worker?.postMessage({type:'audio',enabled:false});audio.dispose();});
document.body.dataset.version = version.value;
start.disabled = false;
