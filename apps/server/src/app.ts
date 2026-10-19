import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { EngineRegistry } from '../../../packages/engine/registry.ts';
import { assertRecord, DomainError, gameVersion, trainerHandle, PROTOCOL_VERSION, GAME_VERSIONS } from '../../../packages/protocol/index.ts';
import { Database } from './database.ts';
import { configuredAccountAuthenticator, type AccountAuthConfig } from './account-auth.ts';
import {Sessions,type SessionOptions} from './sessions.ts';
import { TradeOffers } from './trade-offers.ts';
import { TradeScenes } from './trade-scenes.ts';
import { TradeSceneStore } from './trade-scene-store.ts';
import { PostgresTrades } from './trade-repository.ts';
import {join} from 'node:path';
import {BattleSessions} from './battle-sessions.ts';
import {QuickMatch} from './quick-match.ts';
import {registerBattleApi} from './battle-api.ts';
import {LobbyPresence,LOBBY_CHANNEL} from './lobby-presence.ts';
import {registerLobbyApi} from './lobby-api.ts';
import {WorkerGameInspection} from '../../../packages/trading/worker-pool.ts';
import {parseTrustedProxyCidrs} from './runtime-config.ts';
import {SocketAuthLease} from './socket-auth.ts';
import {monitorSocketHeartbeat} from './socket-heartbeat.ts';
import {gameArtifactUrl} from '../../../packages/engine/artifact-url.ts';

export type ServerConfig = AccountAuthConfig & {
  origin: string; engineDirectory: string; battleEngineDirectory?:string; battleWorkers?:number; adventureWorkers?:number; tradeWorkers?:number;inspectionWorkers?:number;databaseUrl?: string;
  supabaseUrl?: string; publishableKey?: string; publicRelease: boolean;
  trustedProxyCidrs?:string[];
};

export async function createApp(config: ServerConfig, services: { database?: Database; registry?: EngineRegistry; battleRegistry?:EngineRegistry;sessionOptions?:SessionOptions } = {}) {
  if (config.publicRelease) {
    throw new Error('Public release is gated: complete the FireRed port, distributed workers, battle/trade adapters, database verification and 1,000-player qualification first.');
  }
  const trustedProxyCidrs=parseTrustedProxyCidrs(config.trustedProxyCidrs?.join(','));
  const app = Fastify({ bodyLimit: 16 * 1024, trustProxy:trustedProxyCidrs??false, logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'access_token', 'token'] } });
  await app.register(cors, { origin: config.origin, methods: ['GET','POST','DELETE'], allowedHeaders: ['Authorization','Content-Type'] });
  await app.register(websocket, { options: { maxPayload: 16 * 1024,perMessageDeflate:{threshold:1024,
    serverNoContextTakeover:true,clientNoContextTakeover:true,zlibDeflateOptions:{level:3},concurrencyLimit:4} } });
  const registry = services.registry ?? new EngineRegistry();
  if (!services.registry) await registry.load(config.engineDirectory, config.publicRelease);
  const battleRegistry=services.battleRegistry??new EngineRegistry();
  if(!services.battleRegistry)await battleRegistry.load(config.battleEngineDirectory??join(config.engineDirectory,'battle'),config.publicRelease,'battle');
  const accountAuth = configuredAccountAuthenticator(config);
  const database = services.database ?? (config.databaseUrl ? new Database(config.databaseUrl,()=>app.log.warn('Idle database connection closed; the pool will reconnect.'),config.accountOrigin?'netlify':'legacy') : undefined);
  const authenticate = accountAuth?.authenticate;
  const inspection=database?new WorkerGameInspection(registry,config.inspectionWorkers):undefined;
  const sessions=database?new Sessions(database,registry,{pool:config.adventureWorkers,inspection,...services.sessionOptions}):undefined;
  const tradeOffers=database?new TradeOffers(database,registry,services.sessionOptions?.inspection??inspection):undefined;
  const tradeScenes=database?new TradeScenes(registry,new PostgresTrades(database),new TradeSceneStore(database),tradeOffers!,Date.now,config.tradeWorkers):undefined;
  const battles=database?new BattleSessions(database,battleRegistry,Date.now,config.battleWorkers):undefined;
  const quick=battles&&database?new QuickMatch(database,(challenger,challenged)=>battles.quickPair(challenger,challenged)):undefined;
  // Directory presence push is additive: the service starts on the first
  // directory-stream connection, and when it cannot start every client keeps
  // its HTTP page poll while the socket route fails closed.
  const presence=database?new LobbyPresence({
    listen:()=>database.listen(LOBBY_CHANNEL),
    queries:database.pool,
    ...(battles?{live:()=>battles.liveBattles()}:{}),
    onError:error=>app.log.warn({err:error},'Lobby presence listener failed; clients keep polling'),
  }):undefined;
  const sockets = new Map<string, WebSocket>();
  const lobbyHandoffs = new WeakSet<WebSocket>();
  const rateLimits = new Map<string, { count: number; reset: number }>();
  let expiryTimer: ReturnType<typeof setInterval> | undefined;
  let bootstrapExpiryTimer:ReturnType<typeof setInterval>|undefined;
  let bootstrapExpiryPending:Promise<void>|undefined;
  app.addHook('onReady',async()=> {
    if (tradeScenes) expiryTimer=setInterval(()=>void tradeScenes.expire().catch(err=>app.log.error({err},'Trade expiry failed')),30_000).unref();
    if(sessions)bootstrapExpiryTimer=setInterval(()=>{
      if(bootstrapExpiryPending)return;
      bootstrapExpiryPending=sessions.expireUnattached().catch(err=>app.log.error({err},'Adventure bootstrap cleanup failed'))
        .finally(()=>{bootstrapExpiryPending=undefined;});
    },5_000).unref();
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
    const now = Date.now();
    if (rateLimits.size > 10000) for (const [key, entry] of rateLimits) if (entry.reset < now) rateLimits.delete(key);
    const limit = rateLimits.get(request.ip);
    if (!limit || limit.reset < now) rateLimits.set(request.ip, { count: 1, reset: now + 60000 });
    else if (++limit.count > 120) throw new DomainError('RATE_LIMITED', 'Too many requests. Please wait a minute.', 429);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.status(error.status).send({ error: error.code, message: error.message });
    app.log.error({ err: error }, 'Request failed');
    return reply.status(500).send({ error: 'SERVER_ERROR', message: 'The request could not be completed. Your last verified progress is retained.' });
  });

  async function owner(authorization: string | undefined): Promise<string> {
    if (!database || !authenticate) throw new DomainError('SERVICE_UNCONFIGURED', 'Account services have not been configured.', 503);
    const id = await authenticate(authorization);
    await database.profile(id); // Also enforces suspension for every authenticated API.
    return id;
  }
  const closeBattles=registerBattleApi(app,battles,config.origin,owner,quick);
  const closeLobby=registerLobbyApi(app,presence,config.origin,owner,async id=>{
    if(!sessions)throw new DomainError('SERVICE_UNCONFIGURED','Lobby services are not configured.',503);
    await sessions.lobbyPresence(id);
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_request, reply) => {
    const artifacts=registry.status();
    let ready = Boolean(database && authenticate) && GAME_VERSIONS.every(version=>artifacts.some(item=>item.version===version&&item.available));
    if(ready){
      try{await database!.pool.query('select 1');}catch{ready=false;}
    }
    return reply.status(ready ? 200 : 503).send({ ready });
  });
  app.get('/api/status', async () => ({
    protocol: PROTOCOL_VERSION, accountsConfigured: Boolean(database && authenticate),
    engines: registry.status(), publicReleaseReady: false,
    multiplayer: { lobby: Boolean(database && authenticate && registry.status().some(item => item.available)),
      battles:Boolean(database&&authenticate&&battleRegistry.status().some(item=>item.available&&item.manifest?.capabilities.battle===true)),
      trading:Boolean(database && authenticate && registry.status().some(item=>item.available && item.manifest?.capabilities.trade===true)) },
    capacity: { target: 1000, qualified: false },
  }));
  app.get('/api/profile', async request => {
    const id = await owner(request.headers.authorization);
    return { profile: await database!.profile(id) ?? null };
  });
  app.post('/api/profile', async request => {
    const id = await owner(request.headers.authorization);
    assertRecord(request.body);
    const { handle } = trainerHandle(request.body.handle);
    return { profile: await database!.createProfile(id, handle) };
  });
  app.get('/api/adventures', async request => {
    const id = await owner(request.headers.authorization);
    return { adventures: await database!.adventures(id) };
  });
  app.get<{ Params: { version: string } }>('/api/engines/:version/artifact', async (request, reply) => {
    const bytes = registry.artifact(gameVersion(request.params.version));
    // Artifact storage stays immutable. Share its exact byte view instead of
    // allocating another full game file for each concurrent download.
    return reply.type('application/wasm').send(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength));
  });
  app.get<{Params:{version:string}}>('/api/engines/:version/manifest',async request=>{
    const manifest=registry.manifest(gameVersion(request.params.version));
    return {manifest,artifactUrl:gameArtifactUrl(manifest.version,manifest.wasmSha256)};
  });
  app.get<{Params:{version:string;sha256:string}}>('/api/engines/:version/:sha256.wasm',async(request,reply)=>{
    const version=gameVersion(request.params.version),manifest=registry.manifest(version);
    if(request.params.sha256!==manifest.wasmSha256)
      throw new DomainError('ARTIFACT_NOT_FOUND','That game download is unavailable. Reload your adventure.',404);
    const bytes=registry.artifact(version);
    return reply.header('Cache-Control','public, max-age=31536000, immutable').type('application/wasm')
      .send(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength));
  });
  app.post('/api/sessions', async request => {
    const id = await owner(request.headers.authorization);
    assertRecord(request.body);
    if(Object.keys(request.body).some(key=>!['version','adventureId'].includes(key))
      ||request.body.adventureId!==undefined&&typeof request.body.adventureId!=='string')
      throw new DomainError('INVALID_ADVENTURE','Choose an adventure to continue.');
    return sessions!.start(id, gameVersion(request.body.version),request.body.adventureId);
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/checkpoint', async (request, reply) => {
    const id = await owner(request.headers.authorization);
    const checkpoint = await sessions!.checkpoint(id, request.params.id);
    reply.header('Content-Encoding', 'gzip');
    reply.header('X-Kanto-Frame', checkpoint.frame).header('X-Kanto-Sequence', checkpoint.sequence);
    return reply.type('application/octet-stream').send(checkpoint.bytes);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/pause', async request => {
    const id = await owner(request.headers.authorization);
    await sessions!.pause(id, request.params.id);
    return { paused: true };
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/exit', async request => {
    const id = await owner(request.headers.authorization);
    await sessions!.exit(id, request.params.id);
    return { saved: true };
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/lobby', async request => {
    const id = await owner(request.headers.authorization);
    const lobby = await sessions!.enterLobby(id, request.params.id);
    const connection = sockets.get(id);
    if (connection) { lobbyHandoffs.add(connection); connection.close(1000, 'Entered lobby'); }
    return lobby;
  });
  app.get('/api/lobby', async request => {
    const id = await owner(request.headers.authorization);
    return { lobby: await sessions!.lobbyState(id), ...await sessions!.lobbyTrainerPage(id) };
  });
  app.post('/api/lobby/leave', async request => {
    const id = await owner(request.headers.authorization);
    return sessions!.leaveLobby(id);
  });
  app.get('/api/lobby/trainers', async request => {
    const id = await owner(request.headers.authorization);
    await sessions!.lobbyPresence(id);
    return sessions!.lobbyTrainerPage(id,request.query);
  });
  app.get('/api/trades', async request => {
    const id = await owner(request.headers.authorization); return { trades: await tradeOffers!.list(id) };
  });
  app.get<{ Params: { id: string } }>('/api/trades/:id', async request => {
    const id = await owner(request.headers.authorization); return tradeOffers!.get(id, request.params.id);
  });
  app.post('/api/trades', async request => {
    const id = await owner(request.headers.authorization); assertRecord(request.body);
    return tradeOffers!.invite(id, request.body.trainerId as string);
  });
  app.post<{ Params: { id: string } }>('/api/trades/:id/offer', async request => {
    const id = await owner(request.headers.authorization); assertRecord(request.body);
    return tradeOffers!.offer(id, request.params.id, request.body.offerRevision as number, {
      partySlot: request.body.partySlot as number, pokemonDigest: request.body.pokemonDigest as string,
      saveRevision: request.body.saveRevision as number });
  });
  app.post<{ Params: { id: string } }>('/api/trades/:id/confirm', async request => {
    const id = await owner(request.headers.authorization); assertRecord(request.body);
    return tradeOffers!.confirm(id, request.params.id, request.body.offerRevision as number);
  });
  app.post<{ Params: { id: string } }>('/api/trades/:id/cancel', async request => {
    const id = await owner(request.headers.authorization); assertRecord(request.body);
    await tradeScenes!.cancel(id,request.params.id);
    return tradeOffers!.get(id,request.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/trades/:id/scene', async request => {
    const id = await owner(request.headers.authorization); assertRecord(request.body);
    return tradeScenes!.begin(id,request.params.id,request.body.offerRevision as number);
  });
  app.get<{ Params: { id: string } }>('/api/trades/:id/scene/checkpoint', async (request,reply) => {
    const id = await owner(request.headers.authorization), checkpoint = await tradeScenes!.checkpoint(id,request.params.id);
    reply.header('Content-Encoding','gzip').header('X-Kanto-Frame',checkpoint.frame).header('X-Kanto-Sequence',checkpoint.sequence);
    return reply.type('application/octet-stream').send(checkpoint.bytes);
  });
  app.post<{ Params: { id: string } }>('/api/trades/:id/finish', async request => {
    const id = await owner(request.headers.authorization); return tradeScenes!.finish(id,request.params.id);
  });
  for (const path of ['/api/lobby/queue']) {
    app.post(path, async request => {
      await owner(request.headers.authorization);
      throw new DomainError('FEATURE_NOT_READY', 'Online battles and trades are awaiting verified game adapters.', 503);
    });
  }

  app.get('/api/play', { websocket: true }, (socket, request) => {
    if (request.headers.origin !== config.origin) { socket.close(1008, 'Origin not allowed'); return; }
    monitorSocketHeartbeat(socket);
    let ownerId: string | undefined;
    let sessionId: string | undefined;
    let sessionFence: number | undefined;
    let tradeId: string | undefined;
    let pending = 0;
    let active = true;
    let tail = Promise.resolve();
    const authenticationDeadline = setTimeout(() => socket.close(1008, 'Authentication required'), 10000);
    const send = (body: unknown) => { if (active && socket.readyState === 1) socket.send(JSON.stringify(body)); };
    const authentication = new SocketAuthLease(() => send({type:'auth-required',protocol:1}),
      () => { active=false; socket.close(1008, 'Reconnect to refresh authentication'); });
    socket.on('message', raw => {
      if (++pending > 12) { socket.close(1008, 'Too many pending inputs'); return; }
      tail = tail.then(async () => {
        if (!active) return;
        const body: unknown = JSON.parse(raw.toString());
        assertRecord(body);
        if (!ownerId) {
          if (body.type !== 'authenticate' || typeof body.token !== 'string' || typeof body.sessionId !== 'string'
            || body.protocol !== PROTOCOL_VERSION) throw new DomainError('UNAUTHENTICATED', 'Authenticate the game connection.', 401);
          const authenticatedOwner = await owner(`Bearer ${body.token}`);
          if (!active) return;
          ownerId = authenticatedOwner;
          sessionId = body.sessionId;
          if (body.mode==='trade' && typeof body.tradeId==='string') {
            tradeId = body.tradeId;
            const connection = tradeScenes!.connection(ownerId,tradeId);
            if (connection.id!==sessionId) throw new DomainError('SESSION_MISMATCH','This input belongs to another trade scene.',403);
            sessionFence = connection.fence; tradeScenes!.resume(ownerId,tradeId,sessionFence);
          } else {
            sessionFence = sessions!.connectionFence(ownerId, sessionId);
            sessions!.resume(ownerId, sessionId, sessionFence);
          }
          const previous = sockets.get(ownerId);
          if (previous && previous !== socket) previous.close(1008, 'Adventure resumed in another window');
          sockets.set(ownerId, socket);
          clearTimeout(authenticationDeadline);
          authentication.start();
          send({ type: 'ready', protocol: PROTOCOL_VERSION });
        } else if (body.type === 'refresh-auth') {
          if (await authentication.refresh(body,ownerId,owner)) send({type:'auth-refreshed',protocol:1});
        } else if (body.type === 'input') {
          if (tradeId) {
            send(await tradeScenes!.accept(ownerId,tradeId,body,sessionFence!));
            if (tradeScenes!.isDone(ownerId,tradeId,sessionFence!))
              send({ type:'trade-scene-done', ...await tradeScenes!.finish(ownerId,tradeId) });
          } else send(await sessions!.accept(ownerId, sessionId!, body, sessionFence));
        } else if (body.type === 'pause') {
          if (tradeId) await tradeScenes!.checkpoint(ownerId,tradeId,sessionFence);
          else await sessions!.pause(ownerId, sessionId!, sessionFence);
          send({ type: 'paused', protocol: PROTOCOL_VERSION });
        } else if (body.type === 'resume') {
          if (tradeId) tradeScenes!.resume(ownerId,tradeId,sessionFence!);
          else sessions!.resume(ownerId, sessionId!, sessionFence);
          send({ type: 'ready', protocol: PROTOCOL_VERSION });
        } else if (body.type === 'exit') {
          if (tradeId) throw new DomainError('TRADE_BUSY','Finish or cancel this trade before returning to your adventure.',409);
          await sessions!.exit(ownerId, sessionId!, sessionFence);
          send({ type: 'exited', protocol: PROTOCOL_VERSION });
          sockets.delete(ownerId);
          socket.close(1000, 'Adventure saved');
        } else throw new DomainError('INVALID_MESSAGE', 'Unsupported game message.');
      }).catch(error => {
        send({ type: 'error', error: error instanceof DomainError ? error.code : 'CONNECTION_ERROR',
          message: error instanceof DomainError ? error.message : 'The game connection needs to reconnect.' });
        active=false; authentication.close();
        socket.close(1008, 'Resume verified progress');
      }).finally(() => { pending--; });
    });
    socket.on('close', () => {
      active = false;
      clearTimeout(authenticationDeadline); authentication.close();
      if (ownerId && sockets.get(ownerId) === socket) {
        sockets.delete(ownerId);
        if (tradeId) void tail.then(() => tradeScenes!.disconnect(ownerId!,tradeId!,sessionFence!)).catch(error => {
          if (!(error instanceof DomainError && ['TRADE_SCENE_NOT_FOUND','SESSION_REPLACED'].includes(error.code))) app.log.error({err:error},'Trade disconnect checkpoint failed');
        });
        else if (!lobbyHandoffs.has(socket))
          void tail.then(() => sessions!.disconnect(ownerId!, sessionId!, sessionFence!)).catch(error => app.log.error({ err: error }, 'Disconnect checkpoint/release failed'));
      }
    });
  });

  app.addHook('onClose', async () => {
    clearInterval(expiryTimer);
    clearInterval(bootstrapExpiryTimer);
    for (const socket of sockets.values()) socket.close(1001, 'Server restarting');
    await bootstrapExpiryPending;
    let failure:unknown;
    for(const stop of [closeBattles,closeLobby,()=>presence?.stop(),()=>sessions?.close(),()=>tradeScenes?.close(),()=>tradeOffers?.close(),()=>inspection?.close(),()=>accountAuth?.close()]){
      try{await stop();}catch(error){failure??=error;}
    }
    try{if(!services.database)await database?.close();}catch(error){failure??=error;}
    if(failure)throw failure;
  });
  return app;
}
