import pg from 'pg';
import { betterAuth } from 'better-auth';
import { previewAuthOptions } from './preview-cloud.ts';
import { createAuthenticator } from './auth.ts';
import { DomainError } from '../../../packages/protocol/index.ts';

export type AccountAuthConfig = {
  supabaseUrl?: string; publishableKey?: string;
  accountOrigin?: string; accountSecret?: string; accountDatabaseUrl?: string;
};
export type AccountAuthenticator = {
  authenticate(authorization: string | undefined): Promise<string>;
  close(): Promise<void>;
};

/** Borrow a dedicated account pool. Better Auth validates the opaque session
 * in its database on every call; no decoded claims or cached login decision.
 * Only getSession is exposed here, not signup, recovery or email delivery. */
export function createBetterAuthAuthenticator(pool: pg.Pool, origin: string, secret: string) {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password
    || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
    throw new Error('ACCOUNT_ORIGIN must be an exact HTTPS origin or a loopback development origin.');
  if (secret.length < 32) throw new Error('Configure the dedicated Kanto BETTER_AUTH_SECRET.');
  const initialize=()=>betterAuth(previewAuthOptions(pool, origin, secret, async () => { throw new Error('Email endpoints are not exposed by the game service.'); }));
  let auth: ReturnType<typeof initialize> | undefined;
  return async (authorization: string | undefined): Promise<string> => {
    if (!authorization?.startsWith('Bearer ') || authorization.length > 8192 || authorization.length <= 7)
      throw new DomainError('UNAUTHENTICATED', 'Please sign in.', 401);
    let value;
    try {
      const active=auth??=initialize();
      value = await active.api.getSession({ headers: new Headers({ Authorization: authorization }) });
    }
    catch { throw new DomainError('AUTH_UNAVAILABLE', 'Account services are temporarily unavailable. Please try again.', 503); }
    if (!value || !Number.isFinite(new Date(value.session.expiresAt).getTime())
      || new Date(value.session.expiresAt).getTime() <= Date.now()
      || value.user.id !== value.session.userId)
      throw new DomainError('UNAUTHENTICATED', 'Your session expired. Please sign in again.', 401);
    if (!value.user.emailVerified)
      throw new DomainError('EMAIL_UNVERIFIED', 'Confirm your email before starting an adventure.', 403);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.user.id))
      throw new DomainError('UNAUTHENTICATED', 'This account identity is invalid.', 401);
    return value.user.id;
  };
}

/** Exactly one account provider per deployment. Never fall back from a broken
 * Better Auth setup to another provider with a separate identity namespace. */
export function configuredAccountAuthenticator(config: AccountAuthConfig): AccountAuthenticator | undefined {
  const local = Boolean(config.accountOrigin || config.accountSecret || config.accountDatabaseUrl);
  const legacy = Boolean(config.supabaseUrl || config.publishableKey);
  if (local && legacy) throw new Error('Choose one account provider; Better Auth and Supabase cannot be mixed.');
  if (local) {
    if (!config.accountOrigin || !config.accountSecret || !config.accountDatabaseUrl)
      throw new Error('Configure ACCOUNT_ORIGIN, ACCOUNT_DATABASE_URL and BETTER_AUTH_SECRET together.');
    // The authenticator borrows the pool; this configuration boundary owns it.
    // Configuration validation performs no connection or query.
    const pool = new pg.Pool({ connectionString: config.accountDatabaseUrl, max: 2,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 5000,
      application_name: 'kanto-game-accounts' });
    pool.on('error', () => {});
    try {
      const authenticate = createBetterAuthAuthenticator(pool, config.accountOrigin, config.accountSecret);
      return { authenticate, close: () => pool.end() };
    } catch (error) { void pool.end(); throw error; }
  }
  if (legacy) {
    if (!config.supabaseUrl || !config.publishableKey) throw new Error('Configure both Supabase public Auth settings.');
    return { authenticate: createAuthenticator(config.supabaseUrl, config.publishableKey, 5000), close: async () => {} };
  }
  return undefined;
}
