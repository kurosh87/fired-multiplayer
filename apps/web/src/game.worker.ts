import { FRAME_MILLISECONDS, type InputBatch, type InputRun } from '../../../packages/protocol/index.ts';
import type { EngineManifest } from '../../../packages/engine/runtime.ts';
import { initializeCheckpointBaseline, decodeCheckpoint } from '../../../packages/engine/checkpoint.ts';

type Core = {
  memory: WebAssembly.Memory; kanto_abi_version(): number; kanto_boot(seed: number, hasSave: number): number;
  kanto_step(buttons: number, frames: number): number; kanto_frame(): number; kanto_after_restore(): number;
  kanto_state_ptr(): number; kanto_state_size(): number; kanto_render_frame(): number;
  kanto_framebuffer_ptr(): number; kanto_framebuffer_size(): number;
  kanto_flash_ptr(): number; kanto_flash_size(): number;
  kanto_exchange_abi_version?(): number; kanto_exchange_phase?(): number;
  kanto_audio_abi_version?(): number; kanto_audio_ptr?(): number; kanto_audio_samples?(): number;
  kanto_audio_capacity?(): number; kanto_audio_channels?(): number; kanto_audio_rate?(): number; kanto_audio_mixer_rate?(): number;
};
type Command = { type: 'boot'; bytes: ArrayBuffer; checkpoint: ArrayBuffer; manifest: EngineManifest;
  sessionId: string; seed: number; sequence: number; digest: string; mode?: 'trade'; journal?: boolean }
  | { type: 'preview-boot'; bytes: ArrayBuffer; flash: ArrayBuffer; manifest: EngineManifest; sessionId: string; seed: number; sequence: number }
  | { type: 'export-flash'; requestId: string }
  | { type: 'tick'; buttons: number; frames: number }
  | { type: 'audio'; enabled: boolean }
  | { type: 'pause' | 'resume' };
const worker = self as unknown as { postMessage(data: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<Command>) => void) | null };
let core: Core | undefined;
let manifest: EngineManifest;
let sessionId = '';
let sequence = 0;
let startFrame = 0;
let runs: InputRun[] = [];
let paused = true;
let trade = false, tradeDone = false;
let journal = true;
let audioAvailable=false,audioEnabled=false;
let audioWasReady=false;
let tail = Promise.resolve();

function hex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function digest(): Promise<string> {
  const pointer = core!.kanto_state_ptr(); const size = core!.kanto_state_size();
  if (pointer < 0 || size < 1 || pointer + size > core!.memory.buffer.byteLength) throw new Error('Invalid game state region.');
  const prefix = new TextEncoder().encode(manifest.id);
  const data = new Uint8Array(prefix.length + size);
  data.set(prefix); data.set(new Uint8Array(core!.memory.buffer, pointer, size), prefix.length);
  return hex(await crypto.subtle.digest('SHA-256', data));
}

async function seal(): Promise<void> {
  if (!journal || !runs.length) return;
  const batch: InputBatch = { type: 'input', protocol: 1, sessionId, sequence: sequence++,
    operationId: crypto.randomUUID(), startFrame, runs };
  runs = []; startFrame = core!.kanto_frame();
  worker.postMessage({ type: 'batch', batch, digest: await digest() });
}

function render(): void {
  if (core!.kanto_render_frame() !== 0) throw new Error('The game renderer failed.');
  const pointer = core!.kanto_framebuffer_ptr(); const size = core!.kanto_framebuffer_size();
  if (size !== 240 * 160 * 4 || pointer < 0 || pointer + size > core!.memory.buffer.byteLength) throw new Error('Invalid game framebuffer.');
  const pixels = new Uint8Array(core!.memory.buffer, pointer, size).slice();
  worker.postMessage({ type: 'frame', pixels: pixels.buffer, frame: core!.kanto_frame() }, [pixels.buffer]);
}

async function handle(command: Command): Promise<void> {
  if (command.type === 'boot' || command.type === 'preview-boot') {
    manifest = command.manifest; sessionId = command.sessionId; sequence = command.sequence;
    trade = command.type === 'boot' && command.mode==='trade'; tradeDone=false;
    journal = command.type === 'boot' && command.journal !== false;
    runs = [];
    if (trade && !journal) throw new Error('Trades require verified input journals.');
    if (hex(await crypto.subtle.digest('SHA-256', command.bytes)) !== manifest.wasmSha256) throw new Error('The downloaded game failed its integrity check.');
    const module = await WebAssembly.compile(command.bytes);
    if (WebAssembly.Module.imports(module).length) throw new Error('The game has unsupported platform imports.');
    core = (await WebAssembly.instantiate(module, {})).exports as unknown as Core;
    if (typeof core.kanto_render_frame !== 'function') throw new Error('This game artifact is incompatible with the browser.');
    if (command.type === 'preview-boot') {
      if (core.kanto_abi_version() !== 1 || manifest.status !== 'experimental' || command.flash.byteLength !== 131072 || core.kanto_flash_size() !== 131072)
        throw new Error('This preview save is incompatible with the game.');
      const pointer = core.kanto_flash_ptr();
      if (pointer < 0 || pointer + 131072 > core.memory.buffer.byteLength) throw new Error('Invalid game save region.');
      new Uint8Array(core.memory.buffer, pointer, 131072).set(new Uint8Array(command.flash));
      if (core.kanto_boot(command.seed >>> 0, 1) !== 0) throw new Error('The preview save could not start.');
    } else {
      const baseline = initializeCheckpointBaseline(core);
      const restored = decodeCheckpoint(new Uint8Array(command.checkpoint), baseline,
        manifest.wasmSha256, { allowLegacy: true });
      new Uint8Array(core.memory.buffer).set(restored);
      if (core.kanto_after_restore() !== 0 || await digest() !== command.digest) throw new Error('The restored adventure does not match verified progress.');
    }
    if (trade) {
      if (core.kanto_exchange_abi_version?.()!==1 || ![2,3].includes(core.kanto_exchange_phase?.() ?? 0)) throw new Error('The original trade scene cannot resume.');
      tradeDone=core.kanto_exchange_phase!()===3;
    }
    audioAvailable=core.kanto_audio_abi_version?.()===1;
    audioEnabled=false;
    audioWasReady=false;
    if(audioAvailable){
      for(const key of ['kanto_audio_ptr','kanto_audio_samples','kanto_audio_capacity','kanto_audio_channels','kanto_audio_rate','kanto_audio_mixer_rate'] as const)
        if(typeof core[key]!=='function')throw new Error('Incomplete game audio interface.');
      if(core.kanto_audio_channels!()!==2||core.kanto_audio_capacity!()!==4096
        ||!Number.isFinite(core.kanto_audio_rate!())||Math.abs(core.kanto_audio_rate!()-701*1000/FRAME_MILLISECONDS)>0.001
        ||core.kanto_audio_mixer_rate!()!==41869)throw new Error('Unsupported game audio format.');
    }
    startFrame = core.kanto_frame();
    render(); worker.postMessage({ type: 'booted', frame: startFrame, frameMilliseconds: FRAME_MILLISECONDS, audioAvailable });
    if (tradeDone) worker.postMessage({ type:'trade-done' });
  } else if (command.type === 'export-flash') {
    if (!core || core.kanto_flash_size() !== 131072) throw new Error('Start an adventure before syncing a save.');
    const pointer = core.kanto_flash_ptr();
    if (pointer < 0 || pointer + 131072 > core.memory.buffer.byteLength) throw new Error('Invalid game save region.');
    const flash = new Uint8Array(core.memory.buffer, pointer, 131072).slice();
    worker.postMessage({ type: 'flash', requestId: command.requestId, flash: flash.buffer }, [flash.buffer]);
  } else if (command.type === 'tick') {
    if (!core || paused) return;
    if (!Number.isInteger(command.buttons) || command.buttons < 0 || command.buttons > 1023
      || !Number.isInteger(command.frames) || command.frames < 1 || command.frames > 4) throw new Error('Invalid game input.');
    if(audioAvailable&&audioEnabled){
      const chunks:Float32Array[]=[];
      for(let i=0;i<command.frames;i++){
        if(core.kanto_step(command.buttons,1)!==0)throw new Error('The game could not advance.');
        const pointer=core.kanto_audio_ptr!(),count=core.kanto_audio_samples!();
        if(!Number.isSafeInteger(pointer)||pointer<0||pointer%4!==0||!Number.isSafeInteger(count)||count<0||count>4096||count%2!==0
          ||pointer+count*4>core.memory.buffer.byteLength)throw new Error('Invalid game audio region.');
        if(count){
          const samples=new Float32Array(core.memory.buffer,pointer,count).slice();
          if(!samples.every(value=>Number.isFinite(value)&&Math.abs(value)<=1))throw new Error('Invalid game audio samples.');
          chunks.push(samples);
          audioWasReady=true;
        }else if(audioWasReady){
          // Warm reset clears output before the driver reinitializes. Drop
          // pre-reset samples from this tick as well as the playback queue.
          chunks.length=0;audioWasReady=false;worker.postMessage({type:'audio-reset'});
        }
      }
      if(chunks.length){
        const samples=new Float32Array(chunks.reduce((sum,chunk)=>sum+chunk.length,0));let offset=0;
        for(const chunk of chunks){samples.set(chunk,offset);offset+=chunk.length;}
        worker.postMessage({type:'audio',samples:samples.buffer,frame:core.kanto_frame(),rate:core.kanto_audio_rate!(),mixerRate:core.kanto_audio_mixer_rate!()},[samples.buffer]);
      }
    }else if (core.kanto_step(command.buttons, command.frames) !== 0) throw new Error('The game could not advance.');
    if (journal) {
      const previous = runs[runs.length - 1];
      if (previous?.buttons === command.buttons) previous.frames += command.frames;
      else runs.push({ buttons: command.buttons, frames: command.frames });
    }
    if (trade) {
      const phase=core.kanto_exchange_phase!();
      if (![2,3].includes(phase)) throw new Error('The original game could not finish this trade.');
      tradeDone=phase===3;
    }
    if (core.kanto_frame() - startFrame >= 15 || tradeDone) await seal();
    render();
    if (tradeDone) { paused=true; worker.postMessage({ type:'trade-done' }); }
  } else if(command.type==='audio'){
    if(typeof command.enabled!=='boolean')throw new Error('Invalid audio setting.');
    audioEnabled=audioAvailable&&command.enabled;
  } else if (command.type === 'pause') {
    paused = true; await seal(); worker.postMessage({ type: 'paused' });
  } else if (command.type === 'resume') paused = tradeDone;
}

worker.onmessage = event => {
  tail = tail.then(() => handle(event.data)).catch(error => {
    paused = true;
    worker.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'The game needs to reconnect.' });
  });
};
