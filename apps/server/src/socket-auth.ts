import { assertRecord, DomainError } from '../../../packages/protocol/index.ts';

export const SOCKET_AUTH_PROMPT_MS = 10 * 60 * 1000;
export const SOCKET_AUTH_EXPIRY_MS = 15 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000;

/** Revalidate the same account without replacing its game, fence or input clock.
 * Timers start only after the initial connection has authenticated. */
export class SocketAuthLease {
  private prompt?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private closed = false;
  private started = false;
  private lastAttempt = -Infinity;
  private request: () => void;
  private expire: () => void;
  constructor(request: () => void, expire: () => void) { this.request = request; this.expire = expire; }

  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.arm();
  }

  private arm(): void {
    clearTimeout(this.prompt); clearTimeout(this.expiry);
    this.prompt = setTimeout(() => { if (!this.closed) this.request(); }, SOCKET_AUTH_PROMPT_MS);
    this.expiry = setTimeout(() => { this.close(); this.expire(); }, SOCKET_AUTH_EXPIRY_MS);
    this.prompt.unref(); this.expiry.unref();
  }

  async refresh(body: unknown, expectedOwner: string, authorize: (authorization: string) => Promise<string>): Promise<boolean> {
    assertRecord(body);
    if (body.type !== 'refresh-auth' || body.protocol !== 1 || typeof body.token !== 'string'
      || !body.token.length || body.token.length > 8192
      || Object.keys(body).some(key => !['type', 'protocol', 'token'].includes(key)))
      throw new DomainError('INVALID_AUTH_REFRESH', 'Refresh your sign-in to continue.', 401);
    if (this.closed || !this.started) return false;
    if (Date.now() - this.lastAttempt < MIN_REFRESH_MS)
      throw new DomainError('RATE_LIMITED', 'Please wait before refreshing your sign-in again.', 429);
    this.lastAttempt = Date.now();
    const actualOwner = await authorize(`Bearer ${body.token}`);
    if (actualOwner !== expectedOwner)
      throw new DomainError('ACCOUNT_CHANGED', 'Your signed-in account changed. Reopen your adventure.', 401);
    // An Auth request may finish after the socket closed or its deadline passed.
    if (this.closed) return false;
    this.arm();
    return true;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.prompt); clearTimeout(this.expiry);
  }
}
