import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database } from './database.ts';
import { DomainError, type GameVersion } from '../../../packages/protocol/index.ts';
import { PRIVATE_BATTLE_PINS } from '../../../packages/battles/private-artifacts.ts';

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers });
}

/** Test-only branch-preview setup. It reuses the retained qualification save
 * and the same lobby/session rows the native hosted check seeds. Production
 * and ordinary deploy previews never reach this module. */
export async function testLobbyResponse(request: Request, owner: string, database: Database, runtimeDirectory: string): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname !== '/api/online/test-lobby') return json({ error: 'NOT_FOUND' }, 404);
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
    const profile = await database.profile(owner);
    if (!profile) throw new DomainError('ACCOUNT_PROFILE_REQUIRED', 'Reserve your trainer name before playing online.', 409);
    if (request.method === 'GET') {
      const result = await database.pool.query<{ id: string; handle: string; version: GameVersion }>(
        `select p.id,p.handle,a.version from private.game_sessions s
          join public.profiles p on p.id=s.owner_id
          join private.adventures a on a.id=s.adventure_id
          where s.status='lobby' and s.lease_expires_at>clock_timestamp() and s.owner_id<>$1
          order by p.handle limit 20`, [owner]);
      return json({ handle: profile.handle, opponents: result.rows });
    }
    const version: GameVersion = 'firered';
    const flash = await readFile(resolve(runtimeDirectory, `test-${version}.sav`));
    if (flash.byteLength !== 131072) throw new Error('Invalid retained test save.');
    // Share the cloud slot identities first; the hosted private adventure has
    // a composite FK to the cloud adventure, so it cannot be invented here.
    await database.adventures(owner);
    const revision = await database.transaction(async client => {
      await client.query("update private.game_sessions set status='closed' where owner_id=$1 and status<>'closed'", [owner]);
      const adventure = await client.query<{ id: string; revision: string }>(
        `update private.adventures set flash=$3,revision=revision+1,updated_at=clock_timestamp()
          where owner_id=$1 and version=$2 and slot=0
          returning id,revision`, [owner, version, flash]);
      const row = adventure.rows[0];
      if (!row) throw new DomainError('ADVENTURE_REQUIRED', 'Create a cloud adventure before preparing the test lobby.', 409);
      await client.query(
        `insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,initial_flash,base_revision,status,lease_expires_at)
          values(gen_random_uuid(),$1,$2,$3,0,$4,$5,'lobby',clock_timestamp()+interval '10 minutes')`,
        [owner, row.id, PRIVATE_BATTLE_PINS[version].id, flash, row.revision]);
      return Number(row.revision);
    });
    return json({ handle: profile.handle, version, revision, ready: true });
  } catch (error) {
    console.error('test-lobby failed', error);
    if (error instanceof DomainError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: 'TEST_LOBBY_FAILED', message: 'The preview test lobby could not be prepared.',
      detail: error instanceof Error ? error.message : String(error) }, 503);
  }
}
