import {supabase} from './legacy-account-client.ts';
export {supabase} from './legacy-account-client.ts';
import type { GameVersion } from '../../../packages/protocol/index.ts';
import type { EngineManifest } from '../../../packages/engine/runtime.ts';
import {cloudAccountsEnabled,cloudSessionToken,accountCredentials} from './account-session.ts';

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

export type ServiceStatus = {
  protocol: number; accountsConfigured: boolean; publicReleaseReady: boolean;
  engines: { version: GameVersion; available: boolean; reason: string; manifest?: EngineManifest }[];
  multiplayer: { lobby: boolean; battles: boolean; trading: boolean };
  capacity: { target: number; qualified: boolean };
};

export async function token(): Promise<string> {
  if(cloudAccountsEnabled)return cloudSessionToken();
  if(!supabase)throw new Error('Account services need configuration before sign-in is available.');
  const { data } = await supabase!.auth.getSession();
  if (!data.session) throw new Error('Please sign in again.');
  return data.session.access_token;
}

export class ApiError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, message: string, status: number) { super(message); this.name = 'ApiError'; this.code = code; this.status = status; }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const accessToken=await token(),generation=accountCredentials.generation;
  const response = await fetch(`${API_URL}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if(cloudAccountsEnabled&&generation!==accountCredentials.generation)throw new ApiError('ACCOUNT_CHANGED','Your signed-in account changed. Reopen your adventure.',401);
  if (!response.ok) throw new ApiError(result.error ?? 'REQUEST_FAILED', result.message ?? 'The request could not be completed.', response.status);
  return result as T;
}
