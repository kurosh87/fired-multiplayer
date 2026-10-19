import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import WebSocket,{type RawData} from 'ws';
import {request as httpRequest,type ClientRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {createHash} from 'node:crypto';
import {assertRecord,DomainError} from '../../../packages/protocol/index.ts';
import {configuredAccountAuthenticator,type AccountAuthConfig} from './account-auth.ts';
import {monitorSocketHeartbeat} from './socket-heartbeat.ts';
import {parseTrustedProxyCidrs} from './runtime-config.ts';
import {gatewayNodes,gatewayNode,httpRoutingKey,socketRoutingKey,publicGatewayPath,workerArtifactSignature,type GatewayNode} from './gateway-routing.ts';

export type GatewayConfig=AccountAuthConfig&{origin:string;nodes:readonly GatewayNode[];trustedProxyCidrs?:string[]};
const responseHeaders=new Set(['content-type','content-length','cache-control','content-encoding','etag','last-modified','retry-after','x-kanto-frame','x-kanto-sequence']);
const closeCode=(code:number)=>(code>=1000&&code<=1014&&![1004,1005,1006].includes(code))||code>=3000&&code<=4999?code:1011;

/** Stateless routing only. Game state, fences, durable writes, per-player
 * authorization and clocks remain in the API services. */
export async function createGateway(config:GatewayConfig){
  const nodes=gatewayNodes(config.nodes),origin=new URL(config.origin);
  if(!['http:','https:'].includes(origin.protocol)||origin.origin!==config.origin)throw new Error('WEB_ORIGIN must be an exact HTTP(S) origin.');
  const accountAuth=configuredAccountAuthenticator(config);
  if(!accountAuth)throw new Error('Configure an account provider for the game gateway.');
  const authenticate=accountAuth.authenticate;
  const trusted=parseTrustedProxyCidrs(config.trustedProxyCidrs?.join(','));
  const app=Fastify({bodyLimit:16*1024,trustProxy:trusted??false,logger:{redact:['req.headers.authorization','req.headers.cookie','token','access_token']}});
  app.addHook('onClose',()=>accountAuth.close());
  const limits=new Map<string,{count:number;reset:number}>(),transfers=new Set<ClientRequest>(),connections=new Set<()=>void>();
  let closing=false;
  // Run before the websocket plugin's default close handler so peers receive
  // the intended restart code and both halves of each relay are closed.
  app.addHook('preClose',async()=>{
    closing=true;for(const stop of [...connections])stop();for(const transfer of transfers)transfer.destroy();
  });
  await app.register(cors,{origin:config.origin,methods:['GET','POST','DELETE'],allowedHeaders:['Authorization','Content-Type']});
  await app.register(websocket,{options:{maxPayload:16*1024,perMessageDeflate:{threshold:1024,serverNoContextTakeover:true,clientNoContextTakeover:true,zlibDeflateOptions:{level:3},concurrencyLimit:4}}});
  // Keep raw JSON bytes so proxying does not rewrite a mutation body.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
    const now=Date.now();let limit=limits.get(request.ip);
    if(!limit||limit.reset<=now){
      if(limits.size>=10_000){for(const [ip,item] of limits)if(item.reset<=now)limits.delete(ip);}
      if(limits.size>=10_000&&!limits.has(request.ip))throw new DomainError('RATE_LIMITED','Try again shortly.',429);
      limit={count:0,reset:now+60_000};limits.set(request.ip,limit);
    }
    if(++limit.count>120)throw new DomainError('RATE_LIMITED','Too many requests. Please wait a minute.',429);
  });
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof DomainError)return reply.status(error.status).send({error:error.code,message:error.message});
    if(error&&typeof error==='object'&&'statusCode' in error&&error.statusCode===413)
      return reply.status(413).send({error:'PAYLOAD_TOO_LARGE',message:'The request is too large.'});
    app.log.error({err:error},'Gateway request failed');
    return reply.status(503).send({error:'GATEWAY_UNAVAILABLE',message:'The game service is unavailable. Your verified progress is retained.'});
  });
  app.get('/healthz',async()=>({ok:!closing}));
  app.get('/readyz',async(_request,reply)=>{
    const checks=await Promise.all(nodes.map(async node=>{
      try{
        const [response,status]=await Promise.all([fetch(node.origin+'/readyz',{signal:AbortSignal.timeout(2000)}),fetch(node.origin+'/api/status',{signal:AbortSignal.timeout(2000)})]);
        const signature=status.ok?workerArtifactSignature(await status.json()):undefined;
        return response.ok&&(await response.json()).ready===true?signature:undefined;
      }catch{return undefined;}
    }));
    const ready=!closing&&checks.every(Boolean)&&new Set(checks).size===1;
    return reply.status(ready?200:503).send({ready,workers:nodes.length,
      topology:createHash('sha256').update(JSON.stringify(nodes)).digest('hex')});
  });

  app.all('/api/*',async(request,reply)=>{
    const incoming=new URL(request.url,'http://gateway.invalid'),path=incoming.pathname;
    if(path==='/api/play'||path==='/api/battle-play'||path==='/api/lobby-play')throw new DomainError('UPGRADE_REQUIRED','Open a game connection.',426);
    if(!['GET','POST','DELETE'].includes(request.method))throw new DomainError('INVALID_METHOD','Unsupported request method.',405);
    const publicRead=request.method==='GET'&&publicGatewayPath(path);
    const key=publicRead?'public:'+path:httpRoutingKey(path,await authenticate(request.headers.authorization));
    if(closing)throw new DomainError('SERVER_RESTARTING','The game gateway is restarting.',503);
    const node=gatewayNode(nodes,key),target=new URL(node.origin);
    const headers:Record<string,string>={'x-forwarded-for':request.ip};
    for(const name of ['authorization','content-type','origin'] as const){const value=request.headers[name];if(typeof value==='string')headers[name]=value;}
    const body=request.body;
    if(body!==undefined&&!Buffer.isBuffer(body))throw new DomainError('INVALID_BODY','Send a JSON request body.');
    if(body)headers['content-length']=String(body.byteLength);
    reply.hijack();
    let upstream:ClientRequest,settled=false;
    const fail=()=>{
      if(settled)return;settled=true;
      if(reply.raw.headersSent){reply.raw.destroy();return;}
      for(const [name,value] of Object.entries(reply.getHeaders()))if(value!==undefined)reply.raw.setHeader(name,value);
      reply.raw.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});
      reply.raw.end(JSON.stringify({error:'GATEWAY_UNAVAILABLE',message:'The game service is unavailable. Your verified progress is retained.'}));
    };
    const headerDeadline=setTimeout(()=>{fail();upstream?.destroy();},10_000).unref();
    const deadline=setTimeout(()=>{fail();upstream?.destroy();},300_000).unref();
    try{
      upstream=(target.protocol==='https:'?httpsRequest:httpRequest)(target,{method:request.method,path:incoming.pathname+incoming.search,headers},response=>{
        clearTimeout(headerDeadline);
        for(const [name,value] of Object.entries(reply.getHeaders()))if(value!==undefined)reply.raw.setHeader(name,value);
        for(const [name,value] of Object.entries(response.headers))if(responseHeaders.has(name)&&value!==undefined)reply.raw.setHeader(name,value);
        reply.raw.writeHead(response.statusCode??502);
        response.on('error',fail);response.on('end',()=>{settled=true;});response.pipe(reply.raw);
      });
      transfers.add(upstream);
      upstream.on('error',fail);upstream.on('close',()=>{transfers.delete(upstream);clearTimeout(headerDeadline);clearTimeout(deadline);});
      request.raw.on('aborted',()=>upstream.destroy());
      reply.raw.on('close',()=>{if(!reply.raw.writableFinished)upstream.destroy();});
      upstream.end(body);
    }catch{clearTimeout(headerDeadline);clearTimeout(deadline);fail();}
  });

  for(const path of ['/api/play','/api/battle-play','/api/lobby-play'])app.get(path,{websocket:true},(downstream,request)=>{
    if(closing||request.headers.origin!==config.origin){downstream.close(1008,'Origin not allowed');return;}
    monitorSocketHeartbeat(downstream);
    let upstream:WebSocket|undefined,initial=false,stopped=false,linked=false;
    const stop=(code=1001,reason='Game connection closed')=>{
      if(stopped)return;stopped=true;connections.delete(shutdown);clearTimeout(authDeadline);clearTimeout(connectDeadline);
      if(downstream.readyState===WebSocket.OPEN)downstream.close(closeCode(code),reason);
      if(upstream?.readyState===WebSocket.OPEN)upstream.close(closeCode(code),reason);
      else if(upstream?.readyState===WebSocket.CONNECTING)upstream.terminate();
    };
    const shutdown=()=>stop(1001,'Gateway restarting');connections.add(shutdown);
    const authDeadline=setTimeout(()=>stop(1008,'Authentication required'),10_000).unref();
    let connectDeadline:ReturnType<typeof setTimeout>|undefined;
    const relay=(destination:WebSocket,data:RawData,binary:boolean)=>{
      if(destination.readyState!==WebSocket.OPEN||destination.bufferedAmount>512*1024){stop(1013,'Reconnect to restore verified progress');return;}
      destination.send(data,{binary},error=>{if(error)stop(1011,'Game connection interrupted');});
    };
    downstream.on('message',(data,binary)=>{
      if(stopped)return;
      if(initial){if(!linked){stop(1008,'Wait for the game connection');return;}relay(upstream!,data,binary);return;}
      initial=true;
      void(async()=>{
        if(binary)throw new DomainError('UNAUTHENTICATED','Authenticate your game connection.',401);
        const body:unknown=JSON.parse(data.toString());assertRecord(body);
        // Validate the envelope before making a network authorization request.
        socketRoutingKey(path,'00000000-0000-4000-8000-000000000000',body);
        const owner=await authenticate(`Bearer ${body.token}`);
        if(stopped)return;
        const node=gatewayNode(nodes,socketRoutingKey(path,owner,body)),url=new URL(path,node.origin);
        url.protocol=url.protocol==='https:'?'wss:':'ws:';
        upstream=new WebSocket(url,{origin:config.origin,headers:{'x-forwarded-for':request.ip},maxPayload:512*1024,perMessageDeflate:false});
        connectDeadline=setTimeout(()=>stop(1013,'Game service unavailable'),5000).unref();
        upstream.on('open',()=>{
          clearTimeout(connectDeadline);clearTimeout(authDeadline);if(stopped){upstream?.close();return;}
          linked=true;monitorSocketHeartbeat(upstream!);relay(upstream!,data,false);
        });
        upstream.on('message',(message,isBinary)=>relay(downstream,message,isBinary));
        upstream.on('close',(code,reason)=>stop(code,reason.toString()));
        upstream.on('error',()=>stop(1013,'Game service unavailable'));
      })().catch(()=>stop(1008,'Authenticate your game connection'));
    });
    downstream.on('close',(code,reason)=>stop(code,reason.toString()));
    downstream.on('error',()=>stop(1011,'Game connection interrupted'));
  });
  return app;
}
