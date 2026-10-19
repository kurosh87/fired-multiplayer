import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import {createAuthenticator} from '../apps/server/src/auth.ts';
import {gatewayNode} from '../apps/server/src/gateway-routing.ts';

test('real gateway main reads its env file, serves routed HTTP/WS, shuts down and refuses invalid/public startup', {timeout:30_000}, async()=>{
  const folder=await mkdtemp(join(tmpdir(),'kanto-gateway-main-'));
  const origin='http://gateway-main-client.invalid',owner='00000000-0000-4000-8000-000000000001';
  const key='fixture-$literal',children:ChildProcess[]=[],sockets:WebSocket[]=[],backends:Awaited<ReturnType<typeof Fastify>>[]=[];
  let providerRequests=0,badKey=false;
  const provider=createServer((request,response)=>{
    providerRequests++;if(request.headers.apikey!==key)badKey=true;
    response.setHeader('content-type','application/json');
    if(request.url!=='/auth/v1/user'||request.headers.authorization!=='Bearer fixture-owner'){
      response.writeHead(401);response.end('{}');return;
    }
    response.end(JSON.stringify({id:owner,aud:'authenticated',email_confirmed_at:'2026-10-16T00:00:00Z',
      app_metadata:{},user_metadata:{},identities:[],created_at:'2026-10-16T00:00:00Z'}));
  });
  const live=(child:ChildProcess)=>child.exitCode===null&&child.signalCode===null;
  const wait=async(predicate:()=>boolean|Promise<boolean>,label:string)=>{
    const end=Date.now()+7000;while(Date.now()<end){if(await predicate())return;await sleep(10);}throw new Error(`Gateway main timed out: ${label}`);
  };
  try{
    await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));const address=provider.address();assert(address&&typeof address!=='string');
    const authUrl=`http://127.0.0.1:${address.port}`,authorize=createAuthenticator(authUrl,key),nodes=[];
    for(const id of ['alpha','bravo']){
      const backend=Fastify();backends.push(backend);await backend.register(websocket);
      backend.get('/readyz',async()=>({ready:true}));
      backend.get('/api/status',async()=>({protocol:1,accountsConfigured:true,engines:['firered','leafgreen'].map(version=>({version,available:true,manifest:{version,id:`${version}-fixture`,wasmSha256:'a'.repeat(64)}}))}));
      backend.get('/api/profile',async request=>({node:id,owner:await authorize(request.headers.authorization)}));
      backend.get('/api/play',{websocket:true},socket=>{
        socket.on('message',raw=>{
          const body=JSON.parse(raw.toString());
          void authorize(`Bearer ${body.token}`).then(id=>socket.send(JSON.stringify({type:'ready',owner:id,node:body.sessionId})),()=>socket.close(1008));
        });
      });
      nodes.push({id,origin:await backend.listen({host:'127.0.0.1',port:0})});
    }
    // Reserve an ephemeral host port without changing the production entry's
    // refusal of port zero. Failure to bind remains an actual test failure.
    const reservation=createServer();await new Promise<void>(done=>reservation.listen(0,'127.0.0.1',done));
    const reserved=reservation.address();assert(reserved&&typeof reserved!=='string');const port=reserved.port;
    await new Promise<void>(done=>reservation.close(()=>done()));
    const env={HOST:'127.0.0.1',GATEWAY_PORT:String(port),WEB_ORIGIN:origin,SUPABASE_URL:authUrl,
      SUPABASE_PUBLISHABLE_KEY:key,WORKER_NODES_JSON:JSON.stringify(nodes),PUBLIC_RELEASE:'false',TRUST_PROXY_CIDRS:''};
    let index=0;
    const start=async(overrides:Record<string,string>={})=>{
      const path=join(folder,`gateway-${++index}.env`);
      await writeFile(path,Object.entries({...env,...overrides}).map(([name,value])=>`${name}='${value}'`).join('\n')+'\n',{mode:0o600});
      const child=spawn(process.execPath,[`--env-file=${path}`,'--experimental-strip-types','apps/server/src/gateway-main.ts'],{
        env:process.env.NODE_OPTIONS?{NODE_OPTIONS:process.env.NODE_OPTIONS}:{},stdio:['ignore','pipe','pipe']});children.push(child);
      let output='';child.stdout!.on('data',data=>{output=(output+data.toString()).slice(-32_768);});child.stderr!.on('data',data=>{output=(output+data.toString()).slice(-32_768);});
      child.on('error',error=>{output+=String(error);});
      const closed=new Promise<void>(done=>child.once('close',()=>done()));
      return {child,closed,output:()=>output};
    };
    const running=await start(),base=`http://127.0.0.1:${port}`;
    await wait(()=>{assert(live(running.child),running.output());return running.output().includes('Server listening at');},'listen');
    assert.equal((await fetch(base+'/healthz')).status,200);assert.equal((await fetch(base+'/readyz')).status,200);
    const response=await fetch(base+'/api/profile',{headers:{authorization:'Bearer fixture-owner'}});assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{node:gatewayNode(nodes,`owner:${owner}`).id,owner});
    const socket=new WebSocket(base.replace('http:','ws:')+'/api/play',{origin});sockets.push(socket);
    const messages:any[]=[];socket.on('message',raw=>messages.push(JSON.parse(raw.toString())));
    await wait(()=>socket.readyState===WebSocket.OPEN,'socket open');
    socket.send(JSON.stringify({type:'authenticate',protocol:1,token:'fixture-owner',sessionId:owner}));
    await wait(()=>messages.length>0,'socket ready');assert.equal(messages[0].type,'ready');assert.equal(messages[0].owner,owner);
    assert.equal(badKey,false,'Env-file parsing changed a literal public key.');assert(providerRequests>=4);
    let closeCode:number|undefined;socket.once('close',code=>{closeCode=code;});
    assert(running.child.kill('SIGTERM'));await wait(()=>!live(running.child),'SIGTERM exit');await running.closed;
    assert.equal(running.child.exitCode,0);await wait(()=>closeCode!==undefined,'socket shutdown');assert.equal(closeCode,1001);
    const beforeRejected=providerRequests;
    for(const [overrides,expected] of [
      [{PUBLIC_RELEASE:'true'},'Public release is gated'],
      [{GATEWAY_PORT:'0'},'Invalid GATEWAY_PORT'],
      [{WORKER_NODES_JSON:'[]'},'Configure 1–128 gateway worker nodes'],
      [{WEB_ORIGIN:origin+'/'},'WEB_ORIGIN must be an exact'],
      [{TRUST_PROXY_CIDRS:'0.0.0.0/0'},'cannot trust every address'],
    ] as [Record<string,string>,string][]){
      const rejected=await start(overrides);await wait(()=>!live(rejected.child),'invalid config exit');await rejected.closed;
      assert.equal(rejected.child.exitCode,1,rejected.output());assert(rejected.output().includes(expected),rejected.output());
      assert(!rejected.output().includes('Server listening at'));
    }
    assert.equal(providerRequests,beforeRejected,'Invalid startup reached the Auth provider.');
  }finally{
    for(const socket of sockets)socket.terminate();
    for(const child of children)if(live(child)){
      const closed=new Promise<void>(done=>child.once('close',()=>done()));child.kill('SIGKILL');await closed;
    }
    for(const backend of backends)await backend.close();
    provider.closeAllConnections();await new Promise<void>(done=>provider.listening?provider.close(()=>done()):done());
    await rm(folder,{recursive:true,force:true});
  }
});
