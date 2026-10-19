import { FRAME_MILLISECONDS } from '../../../../packages/protocol/index.ts';
export type GameAudioPacket={samples:ArrayBuffer;frame:number;rate:number;mixerRate:number};

/** Bounded, output-only playback. Audio never schedules or advances the game. */
export class BrowserGameAudio {
  private context?:AudioContext;
  private gain?:GainNode;
  private sources=new Set<AudioBufferSourceNode>();
  private nextAt=0;
  private playing=false;
  private generation=0;
  private enabled=false;
  private lastFrame=-1;
  private packets=0;
  private flushes=0;
  private nonSilent=0;
  get stats(){return {enabled:this.enabled,contextState:this.context?.state??'uninitialized',packets:this.packets,
    sources:this.sources.size,queuedSeconds:Math.max(0,this.nextAt-(this.context?.currentTime??0)),flushes:this.flushes,nonSilentPackets:this.nonSilent};}
  async setEnabled(enabled:boolean){
    const generation=++this.generation;this.enabled=enabled;
    if(!enabled){this.flush();return;}
    if(!this.context){
      this.context=new AudioContext({latencyHint:'interactive'});this.gain=this.context.createGain();
      this.gain.gain.value=0.6;this.gain.connect(this.context.destination);
    }
    try{await this.context.resume();}
    catch(error){if(generation===this.generation)this.enabled=false;throw error;}
    if(generation!==this.generation)return;
    if(this.context.state!=='running'){this.enabled=false;throw new Error('Tap Sound again to enable audio in this browser.');}
  }
  resume(){if(this.enabled&&this.context)void this.context.resume().catch(()=>{this.enabled=false;this.flush();});}
  setPlaying(playing:boolean){this.playing=playing;if(!playing)this.flush();}
  reset(){this.flush();this.lastFrame=-1;}
  flush(){
    for(const source of this.sources){source.onended=null;try{source.stop();}catch{}source.disconnect();}
    this.sources.clear();this.nextAt=0;this.flushes++;
  }
  enqueue(packet:GameAudioPacket){
    if(!this.enabled||!this.playing||!this.context||this.context.state!=='running')return;
    if(!Number.isSafeInteger(packet.frame)||packet.frame<=this.lastFrame)return;
    const samples=new Float32Array(packet.samples);
    if(!samples.length||samples.length>16384||samples.length%2||packet.mixerRate!==41869
      ||!Number.isFinite(packet.rate)||Math.abs(packet.rate-701*1000/FRAME_MILLISECONDS)>0.001
      ||!samples.every(value=>Number.isFinite(value)&&Math.abs(value)<=1))throw new Error('Unsupported game audio packet.');
    this.lastFrame=packet.frame;
    const now=this.context.currentTime;
    if(this.nextAt-now>0.25||this.sources.size>=20)this.flush();
    if(this.nextAt<now+0.005)this.nextAt=now+0.04;
    const buffer=this.context.createBuffer(2,samples.length/2,packet.mixerRate);
    for(let channel=0;channel<2;channel++){
      const data=buffer.getChannelData(channel);for(let i=0;i<data.length;i++)data[i]=samples[i*2+channel]!;
    }
    const source=this.context.createBufferSource();source.buffer=buffer;
    source.playbackRate.value=packet.rate/packet.mixerRate;source.connect(this.gain!);
    source.onended=()=>{this.sources.delete(source);source.disconnect();};this.sources.add(source);
    source.start(this.nextAt);this.nextAt+=buffer.duration/source.playbackRate.value;
    this.packets++;if(samples.some(value=>value!==0))this.nonSilent++;
  }
  dispose(){this.enabled=false;this.generation++;this.flush();if(this.context)void this.context.close();this.context=undefined;}
}
