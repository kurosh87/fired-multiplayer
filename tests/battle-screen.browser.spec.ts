import {test,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {BattleScreenEncoder} from '../packages/battles/screen.ts';

test('battle viewer draws only its server screen and recovers a missing delta',async({page},info)=>{
  const directory=resolve('build/game-source/firered/battle');
  const report=JSON.parse(await readFile(resolve(directory,'battle-leafgreen-ordinary-report.json'),'utf8'));
  const manifests=await Promise.all(['firered','leafgreen'].map(async version=>JSON.parse(await readFile(resolve('build/game-source',version,'battle/candidate.json'),'utf8'))));
  expect(report.artifacts).toEqual(manifests.map(manifest=>manifest.id));
  expect(report.deterministicReplay).toBe(true);
  const packets:Uint8Array[][]=[],hashes:string[][]=[];
  for(let side=0;side<2;side++){
    const encoder=new BattleScreenEncoder(),stream=[],expected=[];
    for(const frame of [1000,6000]){
      const pixels=new Uint8Array(await readFile(resolve(directory,`battle-leafgreen-ordinary-${side}-${frame}.rgba`)));
      stream.push(encoder.encode(pixels,frame+1)!);expected.push(createHash('sha256').update(pixels).digest('hex'));
      if(frame===6000)stream.push(encoder.encode(pixels,frame+1,true)!);
    }
    packets.push(stream);hashes.push(expected);
  }
  const server=createServer((request,response)=>{
    const match=/^\/([01])\/([012])$/.exec(request.url??'');
    if(!match){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Access-Control-Allow-Origin':'*','Content-Type':'application/octet-stream'});
    response.end(packets[Number(match[1])]![Number(match[2])]!);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();expect(address&&typeof address!=='string').toBeTruthy();
  const port=typeof address==='object'&&address?address.port:0;
  const downloaded:string[]=[],errors:string[]=[];
  page.on('request',request=>downloaded.push(request.url()));page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto('/');
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;padding:20px;background:#292c28;color:white;font:16px sans-serif}canvas{display:block;width:100%;max-width:720px;image-rendering:pixelated;margin:20px auto}h1{font-size:22px}</style></head><body><h1>Original battle · private screen</h1><canvas width="240" height="160"></canvas></body></html>');
    await page.evaluate(async({moduleUrl,origin})=>{
      const {BattleScreenDecoder}=await import(moduleUrl);
      let decoder=new BattleScreenDecoder();
      const canvas=document.querySelector('canvas')!,context=canvas.getContext('2d')!;
      (window as any).battleViewer={
        async show(side:number,index:number,reset=false){
          if(reset)decoder=new BattleScreenDecoder();
          const response=await fetch(`${origin}/${side}/${index}`);
          const packet=new Uint8Array(await response.arrayBuffer());
          decoder.apply(packet);context.putImageData(new ImageData(decoder.pixels,240,160),0,0);
          const pixels=context.getImageData(0,0,240,160).data;
          const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels.buffer))).map(v=>v.toString(16).padStart(2,'0')).join('');
          return {hash,frame:decoder.frame};
        },
      };
    },{moduleUrl:`/@fs${resolve('packages/battles/screen.ts')}`,origin:`http://127.0.0.1:${port}`});
    for(let side=0;side<2;side++){
      const show=(index:number,reset=false)=>page.evaluate(({side,index,reset})=>(window as any).battleViewer.show(side,index,reset),{side,index,reset});
      expect(await show(0,true)).toEqual({hash:hashes[side]![0],frame:1001});
      await page.screenshot({path:`test-output/screenshots/battle-${info.project.name}-side-${side}-intro.png`});
      expect(await show(1)).toEqual({hash:hashes[side]![1],frame:6001});
      let rejected=false;
      try{await show(1,true);}catch{rejected=true;}expect(rejected).toBe(true);
      expect(await show(2)).toEqual({hash:hashes[side]![1],frame:6001});
      await page.screenshot({path:`test-output/screenshots/battle-${info.project.name}-side-${side}-after-switch.png`});
    }
    expect(errors).toEqual([]);
    expect(downloaded.filter(url=>/\.wasm(?:\?|$)|checkpoint|snapshot/.test(url))).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    await writeFile(resolve('build',`battle-screen-browser-${info.project.name}.json`),JSON.stringify({artifacts:report.artifacts,
      viewport:info.project.name,originalFramebuffers:4,pixelParity:true,deltaRecovery:true,noCoreOrCheckpointDownload:true,
      fullBattleUiQualified:false,hostedMultiplayerQualified:false,publicReleaseQualified:false},null,2)+'\n');
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
