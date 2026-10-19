import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function checkPreviewPerformance(origin:string,publicDir:string,output:string) {
  const workerFile=(await readdir(resolve(publicDir,'assets'))).find(name=>/^game\.worker-.*\.js$/.test(name));assert(workerFile);
  const browser=await chromium.launch({executablePath:process.env.KANTO_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try {
    const page=await browser.newPage();await page.goto(origin);
    const results=await page.evaluate(async({workerFile})=>{
      const runs=[];
      for(const edition of ['firered','leafgreen']){
        const boot=await (await fetch(`/preview-data/${edition}/boot.json`)).json();
        const bytes=await (await fetch(boot.artifactUrl)).arrayBuffer(),checkpoint=await (await fetch(boot.checkpointUrl)).arrayBuffer();
        for(const journal of [true,false]) {
          const worker=new Worker('/assets/'+workerFile,{type:'module'}),timings:number[]=[];let batches=0,frame=0,pixels:ArrayBuffer|undefined;
          let resolveMessage:((value:any)=>void)|undefined,rejectMessage:((error:Error)=>void)|undefined;
          worker.onmessage=({data})=>{if(data.type==='batch'){batches++;return;}if(data.type==='error'){rejectMessage?.(new Error(data.message));return;}
            if(data.type==='frame'){frame=data.frame;pixels=data.pixels;}resolveMessage?.(data);};
          worker.onerror=()=>rejectMessage?.(new Error('Performance worker failed.'));
          const until=async(type:string,command:unknown)=>new Promise<any>((resolve,reject)=>{
            const timeout=setTimeout(()=>reject(new Error('Worker timeout: '+type)),15000);
            resolveMessage=value=>{if(value.type===type){clearTimeout(timeout);resolveMessage=undefined;rejectMessage=undefined;resolve(value);}};
            rejectMessage=error=>{clearTimeout(timeout);reject(error);};worker.postMessage(command);
          });
          try {
            await until('booted',{type:'boot',bytes:bytes.slice(0),checkpoint:checkpoint.slice(0),manifest:boot.manifest,
              seed:boot.seed,sessionId:'performance-check',sequence:0,digest:boot.digest,journal});
            worker.postMessage({type:'resume'});
            for(let tick=0;tick<120;tick++){
              const start=performance.now();await until('frame',{type:'tick',buttons:tick%29===0?1:0,frames:4});timings.push(performance.now()-start);
            }
            const saved=await until('flash',{type:'export-flash',requestId:'performance-save'});
            const hash=async(value:ArrayBuffer)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(b=>b.toString(16).padStart(2,'0')).join('');
            timings.sort((a,b)=>a-b);
            runs.push({edition,journal,frame,batches,pixelsSha256:await hash(pixels!),flashSha256:await hash(saved.flash),
              tickMedianMs:timings[Math.floor(timings.length/2)],tickP95Ms:timings[Math.floor(timings.length*0.95)]});
          }finally{worker.terminate();}
        }
      }
      return runs;
    },{workerFile});
    for(const edition of ['firered','leafgreen']){
      const baseline=results.find(run=>run.edition===edition&&run.journal)!,preview=results.find(run=>run.edition===edition&&!run.journal)!;
      assert(baseline.batches>=20);assert.equal(preview.batches,0);assert.equal(preview.frame,baseline.frame);
      assert.equal(preview.pixelsSha256,baseline.pixelsSha256);assert.equal(preview.flashSha256,baseline.flashSha256);
    }
    const report={checkedAt:new Date().toISOString(),results,previewPeriodicDigestsRemoved:true,matchingRealCorePixelsAndFlash:true,
      verifiedWorkerJournalsPreserved:true,scope:'480 actual C frames per mode/edition in headless Chrome; timings are local diagnostic samples, not a universal FPS or capacity claim.'};
    await writeFile(output+'/performance-report.json',JSON.stringify(report,null,2)+'\n');return report;
  }finally{await browser.close();}
}
