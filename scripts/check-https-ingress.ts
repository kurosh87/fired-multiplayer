/** Guarded native Caddy + real API transport checks. No provider or Docker daemon. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { createApp } from '../apps/server/src/app.ts';
import { EngineRegistry } from '../packages/engine/registry.ts';

const guard = join(homedir(), '.local/bin/mini-build-guard');
if (existsSync(guard)) execFileSync(guard, ['--is-owned'], { stdio: 'pipe' });
const [tag, binaryArgument] = process.argv.slice(2);
assert(tag && /^[a-z0-9-]{1,40}$/.test(tag) && binaryArgument, 'Supply a fresh evidence tag and Caddy 2.11.7 binary path.');
const root = process.cwd(), folder = resolve('build', `${tag}-https`), caddy = resolve(binaryArgument);
assert(!existsSync(folder), 'Preserve earlier evidence.'); mkdirSync(folder, { mode: 0o700 });
const save = (name: string, value: unknown) => writeFileSync(join(folder, name), JSON.stringify(value, null, 2) + '\n');
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const environment = { PATH: process.env.PATH!, HOME: homedir(), DOCKER_HOST: 'unix:///kanto-offline-no-daemon.sock' };
const origin = 'https://client.ingress.invalid';
const artifactDirectory = join(folder, 'empty-artifacts'), tlsDirectory = join(folder, 'tls-data');
mkdirSync(artifactDirectory); mkdirSync(tlsDirectory, { mode: 0o700 });
const runtime = join(folder, 'fixture-runtime.env'), operator = join(folder, 'fixture-operator.env');
writeFileSync(runtime, 'SUPABASE_URL=https://fixture.invalid\nSUPABASE_PUBLISHABLE_KEY=fixture-only\nDATABASE_URL=postgresql://fixture:literal$dollar@fixture.invalid/db\n', { mode: 0o600 });
const operatorText = `KANTO_API_IMAGE=kanto-api-staging:fixture\nKANTO_RUNTIME_ENV_FILE=${runtime}\nKANTO_ENGINE_DIRECTORY=${artifactDirectory}\nKANTO_WEB_ORIGIN=${origin}\nKANTO_API_DOMAIN=api.ingress.invalid\nKANTO_ACME_EMAIL=fixture@example.invalid\nKANTO_CADDYFILE=${resolve('infra/Caddyfile.staging')}\nKANTO_TLS_DIRECTORY=${tlsDirectory}\n`;
writeFileSync(operator, operatorText);
const compose = (path: string) => JSON.parse(execFileSync('docker', ['compose', '--env-file', path,
  '-f', 'infra/compose.staging.yml', '-f', 'infra/compose.https.staging.yml', 'config', '--format', 'json'],
{ env: environment, encoding: 'utf8', timeout: 20_000 }));
const model = compose(operator), api = model.services.api, ingress = model.services.ingress;
assert.deepEqual(Object.keys(model.services).sort(), ['api', 'ingress']);
assert.equal(api.environment.TRUST_PROXY_CIDRS, '172.30.45.2/32');
assert.equal(api.environment.PUBLIC_RELEASE, 'false'); assert.equal(api.environment.GAME_WORKER_TRANSPORT, 'process');
assert.equal(api.ports.length, 1); assert.equal(api.ports[0].host_ip, '127.0.0.1'); assert.equal(api.ports[0].target, 8787);
assert.deepEqual(Object.keys(api.networks), ['https-ingress']);
assert.equal(ingress.networks['https-ingress'].ipv4_address, '172.30.45.2');
assert.equal(model.networks['https-ingress'].ipam.config[0].subnet, '172.30.45.0/28');
assert(ingress.image.endsWith('@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f'));
assert.equal(ingress.user, '1000:1000'); assert.equal(ingress.read_only, true); assert.deepEqual(ingress.cap_drop, ['ALL']);
assert(ingress.security_opt.includes('no-new-privileges:true'));
assert.equal(Number(ingress.mem_limit), 536870912); assert.equal(ingress.mem_limit, ingress.memswap_limit);
assert.equal(ingress.cpus, 0.5); assert.equal(ingress.pids_limit, 64);
assert.deepEqual(ingress.ports.map((port: any) => [String(port.published), port.target]), [['80', 8080], ['443', 8443]]);
assert.equal(ingress.volumes.length, 2);
assert(ingress.volumes.every((mount: any) => mount.type === 'bind' && !mount.bind?.create_host_path));
assert(ingress.volumes.find((mount: any) => mount.target === '/etc/caddy/Caddyfile').read_only);
assert(!ingress.volumes.find((mount: any) => mount.target === '/data').read_only);
assert(!ingress.env_file && !('DATABASE_URL' in ingress.environment));
save('normalized-fixture.json', model);
const alternate = join(folder, 'alternate-operator.env');
writeFileSync(alternate, operatorText + 'KANTO_INGRESS_SUBNET=172.30.46.0/28\nKANTO_INGRESS_PRIVATE_IP=172.30.46.3\n');
assert.equal(compose(alternate).services.api.environment.TRUST_PROXY_CIDRS, '172.30.46.3/32');
for (const key of ['KANTO_API_DOMAIN', 'KANTO_ACME_EMAIL', 'KANTO_CADDYFILE', 'KANTO_TLS_DIRECTORY']) {
  const missing = join(folder, `missing-${key}.env`);
  writeFileSync(missing, operatorText.split('\n').filter(line => !line.startsWith(key + '=')).join('\n'));
  let refused = false; try { compose(missing); } catch { refused = true; } assert(refused, `Missing ${key} was accepted.`);
}

const version = execFileSync(caddy, ['version'], { encoding: 'utf8' }).trim(); assert(version.startsWith('v2.11.7 '));
const caddyEnv = { ...environment, KANTO_API_DOMAIN: 'api.ingress.invalid', KANTO_ACME_EMAIL: 'fixture@example.invalid',
  XDG_DATA_HOME: tlsDirectory, XDG_CONFIG_HOME: join(folder, 'config') };
const production = JSON.parse(execFileSync(caddy, ['adapt', '--config', 'infra/Caddyfile.staging', '--adapter', 'caddyfile', '--validate'],
  { env: caddyEnv, encoding: 'utf8', timeout: 20_000 }));
save('adapted-production.json', production);
assert.equal(production.admin.disabled, true);
let mutations = 0;
const app = await createApp({ origin, engineDirectory: artifactDirectory, publicRelease: false, trustedProxyCidrs: ['127.0.0.1/32'] },
  { registry: new EngineRegistry(), battleRegistry: new EngineRegistry() });
app.log.level = 'silent';
app.get('/__ingress/echo', async request => ({ ip: request.ip, protocol: request.protocol, hostname: request.hostname,
  authorization: request.headers.authorization, url: request.url }));
app.post('/__ingress/mutation', async (request, reply) => {
  mutations++;
  if (request.headers['x-fixture-drop']) { reply.hijack(); reply.raw.destroy(); return reply; }
  return { body: request.body, url: request.url };
});
app.get('/__ingress/socket', { websocket: true }, socket => { socket.on('message', (data, binary) => socket.send(data, { binary })); });
const reserve = async () => {
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert(address && typeof address !== 'string');
  await new Promise<void>(done => server.close(() => done())); return address.port;
};
const backend = await app.listen({ host: '127.0.0.1', port: 0 });
const httpPort = await reserve(), httpsPort = await reserve(); assert.notEqual(httpPort, httpsPort);
const certificate = join(folder, 'fixture-cert.pem'), key = join(folder, 'fixture-key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=api.ingress.invalid',
  '-addext', 'subjectAltName=DNS:api.ingress.invalid,IP:127.0.0.1', '-keyout', key, '-out', certificate], { stdio: 'pipe', timeout: 20_000 });
const fixture = structuredClone(production); let proxyCount = 0;
function adaptRoute(value: any) {
  if (!value || typeof value !== 'object') return;
  if (value.handler === 'reverse_proxy') {
    assert.equal(value.upstreams.length, 1); assert.equal(value.upstreams[0].dial, 'api:8787');
    assert(!value.load_balancing?.retries && !value.load_balancing?.try_duration);
    value.upstreams[0].dial = new URL(backend).host; proxyCount++;
  }
  for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(adaptRoute); else adaptRoute(child);
}
adaptRoute(fixture); assert.equal(proxyCount, 1);
for (const server of Object.values(fixture.apps.http.servers) as any[]) {
  const secure = server.listen.includes(':8443');
  server.listen = [`127.0.0.1:${secure ? httpsPort : httpPort}`];
  server.automatic_https = { disable: true };
  if (secure) server.tls_connection_policies = [{}];
}
// Only listeners, upstream and certificate provisioning change for this local
// run. Proxy routes/transport/headers remain those adapted from production.
fixture.apps.tls = { certificates: { load_files: [{ certificate, key }] } };
const config = join(folder, 'local-fixture.json'); save('local-fixture.json', fixture);
const log = openSync(join(folder, 'caddy.log'), 'wx');
const child = spawn(caddy, ['run', '--config', config], { env: caddyEnv, stdio: ['ignore', log, log] }); closeSync(log);
const childClosed = once(child, 'close'); const sockets: WebSocket[] = [];
const request = (path: string, method = 'GET', headers: Record<string, string> = {}, body?: string) => new Promise<{ status: number; headers: any; body: string }>((done, reject) => {
  const req = httpsRequest({ hostname: '127.0.0.1', port: httpsPort, servername: 'api.ingress.invalid', ca: readFileSync(certificate),
    path, method, headers: { host: 'api.ingress.invalid', ...headers }, timeout: 5000 }, response => {
    const chunks: Buffer[] = []; response.on('data', data => chunks.push(data)); response.once('error', reject);
    response.on('end', () => done({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
  }); req.once('error', reject); req.once('timeout', () => req.destroy(new Error('HTTPS fixture timeout'))); req.end(body);
});
let passed = false;
try {
  let listening = false;
  for (let index = 0; index < 100; index++) {
    assert(child.exitCode === null && child.signalCode === null, readFileSync(join(folder, 'caddy.log'), 'utf8'));
    try { if ((await request('/healthz')).status === 200) { listening = true; break; } } catch { /* Startup only. */ }
    await sleep(20);
  }
  assert(listening, 'Owned Caddy did not become live.');
  const redirect = await fetch(`http://127.0.0.1:${httpPort}/api/status?x=1`, { redirect: 'manual' });
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), 'https://api.ingress.invalid/api/status?x=1');
  assert.equal((await request('/readyz')).status, 503, 'Ingress must not turn an unready game into ready.');
  const echo = await request('/__ingress/echo?q=a%2Fb', 'GET', { authorization: 'Bearer fixture-only',
    'x-forwarded-for': '203.0.113.55', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'spoof.invalid' });
  assert.equal(echo.status, 200); assert.deepEqual(JSON.parse(echo.body), { ip: '127.0.0.1', protocol: 'https',
    hostname: 'api.ingress.invalid', authorization: 'Bearer fixture-only', url: '/__ingress/echo?q=a%2Fb' });
  assert.equal(echo.headers['cache-control'], 'no-store');
  const payload = ' { "fixture": "literal $ and whitespace" } ';
  const post = await request('/__ingress/mutation?revision=2', 'POST', { 'content-type': 'text/plain' }, payload);
  assert.equal(post.status, 200); assert.deepEqual(JSON.parse(post.body), { body: payload, url: '/__ingress/mutation?revision=2' });
  const dropped = await request('/__ingress/mutation', 'POST', { 'content-type': 'text/plain', 'x-fixture-drop': '1' }, payload);
  assert.equal(dropped.status, 502); assert.equal(mutations, 2, 'An ambiguous mutation must not be retried.');
  const connect = (path: string, clientOrigin: string) => {
    const options = { servername: 'api.ingress.invalid', ca: readFileSync(certificate), origin: clientOrigin,
      headers: { host: 'api.ingress.invalid' } };
    const socket = new WebSocket(`wss://127.0.0.1:${httpsPort}${path}`, options); sockets.push(socket); return socket;
  };
  const socket = connect('/__ingress/socket', origin); await once(socket, 'open');
  const message = once(socket, 'message'); const binary = Buffer.from([0, 255, 7, 128, 1]); socket.send(binary);
  const [returned, isBinary] = await message; assert.equal(isBinary, true); assert.deepEqual(returned, binary);
  const denied = connect('/api/play', 'https://other.invalid'); const deniedClose = once(denied, 'close');
  await once(denied, 'open'); const [code] = await deniedClose; assert.equal(code, 1008);
  let limited = false;
  for (let count = 0; count < 125; count++) {
    const response = await request('/healthz', 'GET', { 'x-forwarded-for': `198.51.100.${count + 1}` });
    if (response.status === 429) { limited = true; break; } assert.equal(response.status, 200);
  }
  assert(limited, 'Spoofed forwarded headers bypassed the actual API rate limiter.');
  passed = true;
} finally {
  for (const socket of sockets) socket.terminate();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const stopped = await Promise.race([childClosed.then(() => true), sleep(5000).then(() => false)]);
  if (!stopped) { child.kill('SIGKILL'); await childClosed; }
  await app.close();
}
assert(passed);
const sources = ['infra/Caddyfile.staging', 'infra/compose.staging.yml', 'infra/compose.https.staging.yml',
  'infra/https-staging.env.example', 'apps/server/src/app.ts', 'apps/server/src/runtime-config.ts', 'scripts/check-https-ingress.ts'];
const report = { caddyVersion: version, caddyBinarySha256: sha(caddy), sourceSha256: Object.fromEntries(sources.map(path => [path, sha(path)])),
  offlineComposeValidated: true, nativeCaddyConfigValidated: true, verifiedLocalCertificateHttps: true,
  httpRedirect: true, websocketBinaryRoundtrip: true, actualApiUnreadyPreserved: true,
  actualApiOriginRejection: true, actualApiRateLimitWithSpoofedIpHeaders: true, mutationBodyAndNoRetry: true,
  ownedProxyStopped: child.exitCode !== null || child.signalCode !== null, ownedApiStopped: true,
  localFixtureCertificateOnly: true, publicAcmeQualified: false, linuxContainerQualified: false,
  hostedAccountsQualified: false, capacity1000Qualified: false, dockerDaemonUsed: false, providerChanged: false };
save('report.json', report); console.log(JSON.stringify(report));
