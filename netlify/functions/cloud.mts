import type { Config, Context } from '@netlify/functions';
import { getConnectionString } from '@netlify/database';
import pg from 'pg';
import { createPreviewCloud, type CloudEmail } from '../../apps/server/src/preview-cloud.ts';

let pool: pg.Pool | undefined;
const services = new Map<string, ReturnType<typeof createPreviewCloud>>();
async function deliver(email: CloudEmail) {
  const key = Netlify.env.get('RESEND_API_KEY'), from = Netlify.env.get('AUTH_EMAIL_FROM');
  if (!key || !from) throw new Error('Email sending is not configured.');
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text }) });
  if (!response.ok) throw new Error('Email delivery was rejected.');
}

export default async function handler(request: Request, context: Context) {
  const url = new URL(request.url);
  const site = 'kanto-online-preview.netlify.app';
  // Exact production or immutable deploy hostname for this one Netlify site.
  if (context.site.id !== '4fcf6389-9abb-4239-8134-d99fa08b85d8' || url.protocol !== 'https:'
    || !(url.hostname === site || /^[a-f0-9]{24}--kanto-online-preview\.netlify\.app$/.test(url.hostname)))
    return Response.json({ message: 'Unexpected account endpoint.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  try {
    if (!pool) {
      pool = new pg.Pool({ connectionString: getConnectionString(), max: 2, connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000, statement_timeout: 10000, application_name: 'kanto-netlify-preview' });
      pool.on('error', () => {});
    }
    const origin = url.origin;
    let service = services.get(origin);
    if (!service) {
      service = createPreviewCloud(pool, origin, Netlify.env.get('BETTER_AUTH_SECRET') ?? '', deliver);
      if (services.size > 4) services.clear(); services.set(origin, service);
    }
    return await service.fetch(request, context.ip);
  } catch {
    return Response.json({ message: 'Account setup is temporarily unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const config: Config = { path: '/api/cloud/*', rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
