import { createHash, randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { PostgresDialect, CompiledQuery } from 'kysely';
import type pg from 'pg';
import { assertRecord, DomainError, gameVersion, trainerHandle, type GameVersion } from '../../../packages/protocol/index.ts';

export type CloudSlot = { id: string; slot: number; version: GameVersion; revision: number; hasSave: boolean; updatedAt: string; sha256: string | null };
export type CloudEmail = { to: string; subject: string; text: string };
export function previewAuthOptions(pool: pg.Pool, origin: string, secret: string, deliver: (email: CloudEmail) => Promise<void>, migration = false) {
  return {
    appName: 'Kanto Online', baseURL: origin, basePath: '/api/cloud/auth', secret,
    database: { dialect: new PostgresDialect({ pool, ...(!migration && { onReserveConnection: async connection => {
      await connection.executeQuery(CompiledQuery.raw('set role kanto_netlify_runtime'));
    } }) }), type: 'postgres' as const, schemaName: 'kanto_auth', transaction: true },
    trustedOrigins: [origin],
    plugins: [bearer()],
    emailAndPassword: { enabled: true, requireEmailVerification: true, minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        await deliver({ to: user.email, subject: 'Reset your Kanto Online password', text: `Reset your password: ${url}\n\nIf you did not request this, ignore this email.` });
      } },
    emailVerification: { sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: true, expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        await deliver({ to: user.email, subject: 'Confirm your Kanto Online account', text: `Confirm your email to start your adventure: ${url}\n\nIf you did not create this account, ignore this email.` });
      } },
    session: { expiresIn: 7 * 86400, updateAge: 86400, cookieCache: { enabled: false } },
    advanced: { database: { generateId: () => randomUUID() }, ipAddress: { ipAddressHeaders: ['x-kanto-client-ip'] } },
    rateLimit: { enabled: true, storage: 'database' as const, window: 60, max: 30,
      customRules: { '/sign-in/email': { window: 60, max: 5 }, '/sign-up/email': { window: 60, max: 3 },
        '/request-password-reset': { window: 300, max: 3 } } },
  };
}

export class PreviewCloudStore {
  readonly pool: pg.Pool;
  constructor(pool: pg.Pool) { this.pool = pool; }
  async transaction<T>(owner: string, body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role kanto_netlify_runtime');
      await client.query("select set_config('kanto.owner_id',$1,true)", [owner]);
      const result = await body(client); await client.query('commit'); return result;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
  private async overviewOn(client: pg.PoolClient, owner: string) {
      const profile = (await client.query('select id,handle from kanto_preview.profiles where id=$1', [owner])).rows[0] ?? null;
      const result = await client.query('select id,slot,version,revision,flash is not null as has_save,updated_at,sha256 from kanto_preview.adventures where owner_id=$1 order by version,slot', [owner]);
      return { profile, slots: result.rows.map(row => ({ id: row.id, slot: row.slot, version: row.version, revision: row.revision,
        hasSave: row.has_save, updatedAt: row.updated_at.toISOString(), sha256: row.sha256 })) as CloudSlot[] };
  }
  async overview(owner: string) {
    return this.transaction(owner, client => this.overviewOn(client, owner));
  }
  async reserve(owner: string, value: unknown) {
    const { handle } = trainerHandle(value);
    try {
      await this.transaction(owner, async client => {
        await client.query('insert into kanto_preview.profiles(id,handle) values($1,$2)', [owner, handle]);
        await client.query("insert into kanto_preview.adventures(owner_id,version) values($1,'firered'),($1,'leafgreen')", [owner]);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('HANDLE_UNAVAILABLE', 'That name is already reserved, or you already have a trainer.', 409);
      throw error;
    }
    return this.overview(owner);
  }
  async createAdventure(owner: string, version: GameVersion) {
    return this.transaction(owner, async client => {
      if (!(await client.query('select id from kanto_preview.profiles where id=$1', [owner])).rowCount)
        throw new DomainError('TRAINER_REQUIRED', 'Choose your trainer name before creating adventures.', 409);
      for (let attempt = 0; attempt < 3; attempt++) {
        const created = await client.query(`insert into kanto_preview.adventures(owner_id,version,slot)
          select $1,$2,n from generate_series(0,2) n where not exists
          (select 1 from kanto_preview.adventures where owner_id=$1 and version=$2 and slot=n)
          order by n limit 1 on conflict(owner_id,version,slot) do nothing returning id`, [owner,version]);
        if (created.rowCount) return { ...await this.overviewOn(client, owner), createdId: created.rows[0].id as string };
      }
      throw new DomainError('ADVENTURE_LIMIT', 'You can keep three adventures per edition. Continue one of your existing adventures.', 409);
    });
  }
  async edition(owner: string, id: string): Promise<GameVersion> {
    return this.transaction(owner, async client => {
      const row = (await client.query('select version from kanto_preview.adventures where owner_id=$1 and id=$2', [owner,id])).rows[0];
      if (!row) throw new DomainError('SAVE_NOT_FOUND', 'This adventure is unavailable.', 404);
      return row.version;
    });
  }
  async read(owner: string, version: GameVersion, id?: string) {
    return this.transaction(owner, async client => {
      const row = (await client.query(`select revision,flash,sha256 from kanto_preview.adventures where owner_id=$1 and version=$2 and ${id ? 'id=$3' : 'slot=0'}`, id ? [owner,version,id] : [owner,version])).rows[0];
      if (!row?.flash) throw new DomainError('SAVE_NOT_FOUND', 'No cloud save exists for this edition yet.', 404);
      return { revision: row.revision as number, bytes: row.flash as Buffer, sha256: row.sha256 as string };
    });
  }
  async save(owner: string, version: GameVersion, revision: number, bytes: Buffer, id?: string) {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 2147483647 || bytes.length !== 131072)
      throw new DomainError('INVALID_SAVE', 'The save or its revision is invalid.');
    if (bytes.every(value => value === 255) || bytes.every(value => value === 0))
      throw new DomainError('EMPTY_SAVE', 'Use SAVE in the game menu before syncing your adventure.');
    const hash = createHash('sha256').update(bytes).digest('hex');
    return this.transaction(owner, async client => {
      const result = await client.query(`update kanto_preview.adventures set flash=$4,sha256=$5,revision=revision+1,updated_at=clock_timestamp()
        where owner_id=$1 and version=$2 and revision=$3 and ${id ? 'id=$6' : 'slot=0'} returning revision`, id ? [owner,version,revision,bytes,hash,id] : [owner,version,revision,bytes,hash]);
      if (!result.rowCount) {
        const current = (await client.query(`select revision,sha256 from kanto_preview.adventures where owner_id=$1 and version=$2 and ${id ? 'id=$3' : 'slot=0'} for update`, id ? [owner,version,id] : [owner,version])).rows[0];
        if (!(current?.revision === revision + 1 && current.sha256 === hash))
          throw new DomainError('SAVE_CONFLICT', 'Another tab changed this cloud save. Load it before syncing again.', 409);
      }
      // Return the revision while this slot is still locked. A subsequent tab's
      // write must not become the revision acknowledged for this upload.
      return this.overviewOn(client, owner);
    });
  }
}

export function createPreviewCloud(pool: pg.Pool, origin: string, secret: string, deliver: (email: CloudEmail) => Promise<void>) {
  if (secret.length < 32) throw new Error('Kanto needs its own strong auth secret.');
  const auth = betterAuth(previewAuthOptions(pool, origin, secret, deliver));
  const store = new PreviewCloudStore(pool);
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  return { auth, store, async fetch(request: Request, clientIp: string) {
    try {
      const url = new URL(request.url);
      if (url.origin !== origin) return json({ message: 'Unexpected request origin.' }, 403);
      const headers = new Headers(request.headers); headers.set('x-kanto-client-ip', clientIp);
      request = new Request(request, { headers });
      if (url.pathname.startsWith('/api/cloud/auth/')) {
        const response = await auth.handler(request);
        response.headers.set('Cache-Control', 'no-store'); return response;
      }
      if (!['GET', 'POST'].includes(request.method)) return json({ message: 'Method not allowed.' }, 405);
      if (request.method === 'POST' && request.headers.get('origin') !== origin) return json({ message: 'Unexpected request origin.' }, 403);
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user.emailVerified) return json({ message: 'Sign in with a confirmed email to use account saves.' }, 401);
      const owner = session.user.id;
      if (url.pathname === '/api/cloud/profile') {
        if (request.method === 'GET') return json(await store.overview(owner));
        const body: unknown = await request.json(); assertRecord(body); return json(await store.reserve(owner, body.handle));
      }
      if (url.pathname === '/api/cloud/adventures' && request.method === 'POST') {
        const body: unknown = await request.json(); assertRecord(body);
        return json(await store.createAdventure(owner, gameVersion(body.version)));
      }
      const match = /^\/api\/cloud\/saves\/(firered|leafgreen)$/.exec(url.pathname);
      const adventure = /^\/api\/cloud\/adventures\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/save$/.exec(url.pathname);
      if (!match && !adventure) return json({ message: 'Not found.' }, 404);
      const id = adventure?.[1];
      const version = id ? await store.edition(owner,id) : gameVersion(match![1]);
      if (request.method === 'GET') {
        const saved = await store.read(owner, version, id);
        return new Response(new Uint8Array(saved.bytes), { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
          'X-Kanto-Revision': String(saved.revision), 'X-Kanto-Sha256': saved.sha256 } });
      }
      const declaredLength = Number(request.headers.get('content-length'));
      if (declaredLength > 131072) return json({ message: 'The save is too large.' }, 413);
      const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (!reader) return json({ message: 'A game save is required.' }, 400);
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length; if (size > 131072) { await reader.cancel(); return json({ message: 'The save is too large.' }, 413); }
        chunks.push(next.value);
      }
      const revision = request.headers.get('x-kanto-revision');
      if (revision === null || !/^\d+$/.test(revision)) return json({ message: 'A save revision is required.' }, 400);
      return json(await store.save(owner, version, Number(revision), Buffer.concat(chunks), id));
    } catch (error) {
      if (error instanceof DomainError) return json({ error: error.code, message: error.message }, error.status);
      if (error instanceof SyntaxError) return json({ message: 'Invalid request.' }, 400);
      return json({ message: 'Account saves are temporarily unavailable. Your existing cloud save has been kept.' }, 503);
    }
  } };
}
