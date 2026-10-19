import { createClient } from '@supabase/supabase-js';
import { DomainError } from '../../../packages/protocol/index.ts';

export function createAuthenticator(url: string, publishableKey: string,requestTimeoutMs?:number) {
  if(requestTimeoutMs!==undefined&&(!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>30_000))
    throw new Error('Auth request timeout must be between 1 and 30000 milliseconds.');
  const client = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false },
    ...(requestTimeoutMs===undefined?{}:{global:{fetch:(input,init)=>{
      const original=init?.signal??(input instanceof Request?input.signal:undefined),deadline=AbortSignal.timeout(requestTimeoutMs);
      return fetch(input,{...init,signal:original?AbortSignal.any([original,deadline]):deadline});
    }}}) });
  return async (authorization: string | undefined): Promise<string> => {
    if (!authorization?.startsWith('Bearer ') || authorization.length > 8192) throw new DomainError('UNAUTHENTICATED', 'Please sign in.', 401);
    // Ask Auth for the user instead of trusting editable metadata or decoded claims.
    const { data, error } = await client.auth.getUser(authorization.slice(7));
    if(requestTimeoutMs!==undefined&&error?.name==='AuthRetryableFetchError')
      throw new DomainError('AUTH_UNAVAILABLE','Account services are temporarily unavailable. Please try again.',503);
    if (error || !data.user) throw new DomainError('UNAUTHENTICATED', 'Your session expired. Please sign in again.', 401);
    if (!data.user.email_confirmed_at) throw new DomainError('EMAIL_UNVERIFIED', 'Confirm your email before starting an adventure.', 403);
    return data.user.id;
  };
}
