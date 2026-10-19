import { test, expect } from '@playwright/test';

for(const version of ['firered','leafgreen'])test(`${version} produces audible bounded audio and flushes on pause, mute and restart`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const activate=async(name:string)=>{const button=page.getByRole('button',{name,exact:true});if(info.project.name==='mobile')await button.tap();else await button.click();};
  const privateRequests:string[]=[];page.on('request',request=>{if(/\/api\/|\/__engine-preview\//.test(request.url()))privateRequests.push(request.url());});
  // Observe native Web Audio output without replacing its processing or game
  // input. A silent side-chain analyser measures samples at the real gain node.
  await page.addInitScript(()=>{
    const NativeAudioContext=window.AudioContext;
    (window as any).audioContexts=[];(window as any).audioPackets=[];(window as any).audioResets=0;
    (window as any).AudioContext=class extends NativeAudioContext{
      constructor(options?:AudioContextOptions){super(options);(window as any).audioContexts.push(this);}
      createGain(){
        const gain=super.createGain(),analyser=this.createAnalyser();
        analyser.fftSize=256;gain.connect(analyser);(this as any).analyser=analyser;return gain;
      }
    };
    window.Worker=new Proxy(window.Worker,{construct(Target,args){
      const worker=new Target(...args as [string|URL,WorkerOptions?]),send=worker.postMessage.bind(worker) as (...args:any[])=>void;let enabled=false,lastFrame=-1,renderedFrame=0;
      worker.postMessage=(message:any,...rest:any[])=>{
        if(message.type==='audio'){enabled=message.enabled;lastFrame=-1;}
        if(message.type==='pause'){(window as any).workerPaused=false;(window as any).pauseRequestedFrame=renderedFrame;}
        if(message.type==='resume')(window as any).workerPaused=false;
        return send(message,...rest);
      };
      worker.addEventListener('message',({data}:MessageEvent)=>{
        if(data.type==='frame')renderedFrame=data.frame;
        if(data.type==='paused')(window as any).workerPaused=true;
        if(data.type==='audio-reset'){lastFrame=-1;(window as any).audioResets++;}
        if(data.type==='audio'&&enabled){
          const samples=new Float32Array(data.samples),delta=lastFrame<0?undefined:data.frame-lastFrame;
          (window as any).audioPackets.push({length:samples.length,delta,frame:data.frame});
          if((window as any).audioPackets.length>300)(window as any).audioPackets.shift();lastFrame=data.frame;
        }
      });return worker;
    }});
  });
  await page.goto('/engine-preview.html');
  await page.getByRole('combobox',{name:'Game',exact:true}).selectOption(version);
  await activate('Start preview');
  const frame=()=>page.locator('canvas').getAttribute('data-frame').then(Number);
  await expect.poll(frame,{timeout:30000}).toBeGreaterThan(240);
  const sound=page.getByRole('button',{name:'Enable sound',exact:true});await expect(sound).toBeEnabled();await activate('Enable sound');
  await expect(page.getByRole('button',{name:'Mute sound',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect.poll(()=>page.locator('#sound-toggle').getAttribute('data-non-silent-packets').then(Number)).toBeGreaterThan(5);
  await expect.poll(()=>page.evaluate(()=>{
    const context=(window as any).audioContexts.at(-1),analyser=context?.analyser;
    if(!analyser)return 0;const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
    return Math.max(...samples.map(Math.abs));
  })).toBeGreaterThan(0.00001);
  await expect(page.locator('#sound-toggle')).toHaveAttribute('data-queued-seconds',/.+/);
  expect(Number(await page.locator('#sound-toggle').getAttribute('data-queued-seconds'))).toBeLessThan(0.33);
  // Opening the Radix tooltip rerenders its trigger; click bindings must
  // survive that update and repeated toggles.
  if(info.project.name==='desktop'){await page.locator('#sound-toggle').hover();await expect(page.getByRole('tooltip')).toHaveText('Toggle game sound');}
  await activate('Mute sound');
  await expect(page.locator('#sound-toggle')).toHaveAttribute('aria-pressed','false');
  await activate('Enable sound');
  await expect(page.locator('#sound-toggle')).toHaveAttribute('aria-pressed','true');
  const packets=await page.evaluate(()=>(window as any).audioPackets);
  expect(packets.length).toBeGreaterThan(5);
  for(const packet of packets)if(packet.delta!==undefined)expect(packet.length).toBe(packet.delta*1402);
  await activate('Pause');
  await expect.poll(()=>page.evaluate(()=>(window as any).workerPaused)).toBe(true);
  expect((await frame())-await page.evaluate(()=>(window as any).pauseRequestedFrame)).toBeLessThanOrEqual(4);
  await expect.poll(()=>page.evaluate(()=>{
    const analyser=(window as any).audioContexts.at(-1).analyser,samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
    return Math.max(...samples.map(Math.abs));
  })).toBe(0);
  const paused=await frame();await page.waitForTimeout(150);expect(await frame()).toBe(paused);
  await activate('Resume');await expect.poll(frame).toBeGreaterThan(paused+15);
  await page.locator('canvas').focus();
  for(const key of ['KeyZ','KeyX','Enter','Backspace'])await page.keyboard.down(key);
  await page.waitForTimeout(60);
  for(const key of ['KeyZ','KeyX','Enter','Backspace'])await page.keyboard.up(key);
  await expect.poll(()=>page.evaluate(()=>(window as any).audioResets)).toBeGreaterThan(0);
  const resetFrame=await frame();await expect.poll(frame,{timeout:10000}).toBeGreaterThan(resetFrame+200);
  await activate('Mute sound');await expect(page.locator('#sound-toggle')).toHaveAttribute('aria-pressed','false');
  await activate('Restart preview');await expect(page.getByRole('dialog',{name:'Restart preview?',exact:true})).toBeVisible();
  await activate('Restart adventure');await expect.poll(frame).toBeLessThan(paused);
  await expect(page.getByRole('button',{name:'Enable sound',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);await expect(page.getByRole('alert')).toBeHidden();
  if(process.env.KANTO_PREVIEW_URL)expect(privateRequests).toEqual([]);
  const tag=process.env.KANTO_AUDIO_EVIDENCE_TAG??'audio';expect(tag).toMatch(/^[a-z0-9-]{1,40}$/);
  await page.screenshot({path:`test-output/screenshots/${tag}-${version}-${info.project.name}.png`,fullPage:true});
});
