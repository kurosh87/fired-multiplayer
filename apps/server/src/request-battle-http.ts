import { assertRecord, DomainError } from '../../../packages/protocol/index.ts';
import { battleId } from '../../../packages/battles/protocol.ts';
import type { RequestBattles } from './request-battles.ts';

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
async function jsonBody(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json') throw new DomainError('INVALID_CONTENT_TYPE','Send JSON battle inputs.',415);
  const reader = request.body?.getReader(); if (!reader) throw new DomainError('INVALID_BATTLE_REQUEST','Send a JSON request.');
  let length = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      length += item.value.byteLength;
      if (length > 8192) { await reader.cancel(); throw new DomainError('REQUEST_TOO_LARGE','The battle input request is too large.',413); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { throw new DomainError('INVALID_BATTLE_REQUEST','Send valid JSON battle inputs.'); }
}
function empty(value: unknown): void { assertRecord(value); if (Object.keys(value).length) throw new DomainError('INVALID_BATTLE_REQUEST','This action takes no additional fields.'); }

/** Same-origin Request/Response boundary shared by the native HTTP check and
 * the eventual Netlify wrapper. Authentication is rechecked on every call. */
export function requestBattleHttp(service: RequestBattles, authenticate: (authorization: string | undefined) => Promise<string>, origin: string) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url), suppliedOrigin = request.headers.get('Origin');
      if (url.origin !== origin || url.search || suppliedOrigin && suppliedOrigin !== origin || request.method === 'POST' && suppliedOrigin !== origin)
        throw new DomainError('WRONG_ORIGIN','Open battles from the Kanto application.',403);
      const path = url.pathname.match(/^\/api\/online\/battles(?:\/([^/]+)(?:\/(accept|step|decline|open))?)?$/);
      if (!path) return Response.json({error:'NOT_FOUND',message:'Battle endpoint not found.'},{status:404,headers});
      if (!['GET','POST'].includes(request.method)) return Response.json({error:'METHOD_NOT_ALLOWED',message:'Use a supported battle action.'},{status:405,headers:{...headers,Allow:'GET, POST'}});
      const owner = await authenticate(request.headers.get('Authorization') ?? undefined); await service.requireTrainer(owner);
      const id = path[1] ? battleId(path[1]) : undefined, action = path[2];
      if (request.method === 'GET') {
        if (action) throw new DomainError('METHOD_NOT_ALLOWED','This battle action requires POST.',405);
        return Response.json(id ? await service.get(owner,id) : {battles:await service.repository.list(owner)},{headers});
      }
      const body = await jsonBody(request);
      if (!id) {
        assertRecord(body);
        if (Object.keys(body).some(key=>!['trainerId','watchable'].includes(key))
          || 'watchable' in body && typeof body.watchable !== 'boolean')
          throw new DomainError('INVALID_BATTLE_REQUEST','Choose a trainer and whether spectators may watch.');
        return Response.json(await service.repository.challenge(owner,battleId(body.trainerId),body.watchable===true),{headers});
      }
      if (action === 'step') return new Response(new Uint8Array(await service.step(owner,id,body)),{
        headers:{...headers,'Content-Type':'application/vnd.kanto.battle-response','Content-Encoding':'gzip'}});
      if(action==='open'){
        assertRecord(body);
        if(Object.keys(body).some(key=>!['connectionId','expectedEpoch'].includes(key))||!Number.isSafeInteger(body.expectedEpoch)||Number(body.expectedEpoch)<0)
          throw new DomainError('INVALID_BATTLE_REQUEST','Open a personal battle connection.');
        return Response.json(await service.open(owner,id,battleId(body.connectionId),Number(body.expectedEpoch)),{headers});
      }
      empty(body);
      if (action === 'accept') return Response.json(await service.accept(owner,id),{headers});
      if (action === 'decline') return Response.json(await service.repository.decline(owner,id),{headers});
      return Response.json({error:'NOT_FOUND',message:'Battle action not found.'},{status:404,headers});
    } catch (error) {
      const known = error instanceof DomainError;
      return Response.json({error:known?error.code:'BATTLE_UNAVAILABLE',message:known?error.message:'Battle execution is temporarily unavailable. Retry the same request.'},
        {status:known?error.status:503,headers});
    }
  };
}
