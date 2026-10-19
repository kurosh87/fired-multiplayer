import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { parseTrustedProxyCidrs } from './runtime-config.ts';
import { privateWorkerTransport } from '../../../packages/engine/private-worker-transport.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const port = Number(process.env.PORT ?? 8787);
privateWorkerTransport();
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
const app = await createApp({
  origin: process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5173',
  engineDirectory: resolve(root, process.env.ENGINE_DIRECTORY ?? 'engine/artifacts'),
  battleEngineDirectory: process.env.BATTLE_ENGINE_DIRECTORY ? resolve(root,process.env.BATTLE_ENGINE_DIRECTORY) : undefined,
  battleWorkers:process.env.BATTLE_WORKERS?Number(process.env.BATTLE_WORKERS):undefined,
  adventureWorkers:process.env.ADVENTURE_WORKERS?Number(process.env.ADVENTURE_WORKERS):undefined,
  tradeWorkers:process.env.TRADE_WORKERS?Number(process.env.TRADE_WORKERS):undefined,
  inspectionWorkers:process.env.INSPECTION_WORKERS?Number(process.env.INSPECTION_WORKERS):undefined,
  databaseUrl: process.env.DATABASE_URL,
  supabaseUrl: process.env.SUPABASE_URL,
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
  accountOrigin: process.env.ACCOUNT_ORIGIN,
  accountDatabaseUrl: process.env.ACCOUNT_DATABASE_URL,
  accountSecret: process.env.BETTER_AUTH_SECRET,
  publicRelease: process.env.PUBLIC_RELEASE === 'true',
  trustedProxyCidrs:parseTrustedProxyCidrs(process.env.TRUST_PROXY_CIDRS),
});
for (const signal of ['SIGTERM','SIGINT'] as const) process.once(signal, () => {
  void app.close().then(() => process.exit(0));
});
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
