import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { SocketAuthLease, SOCKET_AUTH_PROMPT_MS, SOCKET_AUTH_EXPIRY_MS } from '../apps/server/src/socket-auth.ts';
import { maintainSocketAuthentication } from '../apps/web/src/lib/socket-auth.ts';
import { DomainError } from '../packages/protocol/index.ts';

const refresh = { type: 'refresh-auth', protocol: 1, token: 'fresh-fixture-token' };

test('same-account authentication renews a live connection past its original deadline; silence expires it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  let prompts = 0, expired = 0, checked = 0;
  const lease = new SocketAuthLease(() => prompts++, () => expired++);
  try {
    lease.start();
    for (let cycle = 0; cycle < 3; cycle++) {
      t.mock.timers.tick(SOCKET_AUTH_PROMPT_MS);
      assert.equal(prompts, cycle + 1); assert.equal(expired, 0);
      assert(await lease.refresh(refresh, 'alice', async header => {
        assert.equal(header, 'Bearer fresh-fixture-token'); checked++; return 'alice';
      }));
    }
    assert.equal(checked, 3);
    t.mock.timers.tick(SOCKET_AUTH_EXPIRY_MS);
    assert.equal(expired, 1);
    assert.equal(await lease.refresh(refresh, 'alice', async () => { throw new Error('Closed leases must not query Auth.'); }), false);
  } finally { lease.close(); }
});

test('refresh rejects another account, failed authorization, injected controls and repeated Auth work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const invalid: unknown[] = [null, {}, {...refresh,protocol:2}, {...refresh,token:''}, {...refresh,token:'x'.repeat(8193)}, {...refresh,buttons:1}, {...refresh,sessionId:'other'}];
  for (const body of invalid) {
    const lease = new SocketAuthLease(() => {}, () => {}); lease.start();
    try { await assert.rejects(lease.refresh(body,'alice',async () => { throw new Error('Malformed request reached Auth.'); })); }
    finally { lease.close(); }
  }
  for (const failure of ['account', 'expired', 'suspended'] as const) {
    const lease = new SocketAuthLease(() => {}, () => {}); lease.start();
    try {
      await assert.rejects(lease.refresh(refresh,'alice',async () => {
        if(failure === 'account') return 'bob';
        throw new DomainError(failure === 'expired' ? 'UNAUTHENTICATED' : 'ACCOUNT_SUSPENDED','fixture denial',403);
      }), {code: failure === 'account' ? 'ACCOUNT_CHANGED' : failure === 'expired' ? 'UNAUTHENTICATED' : 'ACCOUNT_SUSPENDED'});
      await assert.rejects(lease.refresh(refresh,'alice',async () => { throw new Error('Repeated refresh reached Auth.'); }), {code:'RATE_LIMITED'});
    } finally { lease.close(); }
  }
});

test('a delayed authorization response cannot resurrect an expired or disconnected socket', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  for(const disconnect of [false,true]) {
    let expired=0,complete!: (id:string)=>void;
    const lease=new SocketAuthLease(()=>{},()=>expired++);lease.start();
    const pending=lease.refresh(refresh,'alice',()=>new Promise(resolve=>{complete=resolve;}));
    if(disconnect)lease.close();else t.mock.timers.tick(SOCKET_AUTH_EXPIRY_MS);
    complete('alice');assert.equal(await pending,false);
    t.mock.timers.tick(SOCKET_AUTH_EXPIRY_MS*2);assert.equal(expired,disconnect?0:1);
    lease.close();
  }
});

test('the browser auth handler uses current credentials over a real socket and disposes pending work on close', async () => {
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const address=server.address();assert(address&&typeof address!=='string');
  const accepted=once(server,'connection');
  const browser=new WebSocket(`ws://127.0.0.1:${address.port}`);
  let calls=0,complete!:(value:string)=>void;
  const stop=maintainSocketAuthentication(browser,()=>{calls++;return new Promise(resolve=>{complete=resolve;});});
  try {
    const [peer]=await accepted;await once(browser,'open');
    peer.send(new Uint8Array([1,2,3]));peer.send('not-json');peer.send(JSON.stringify({type:'auth-required',protocol:2}));
    const challenge=JSON.stringify({type:'auth-required',protocol:1});peer.send(challenge);peer.send(challenge);
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,1);
    const received=once(peer,'message');complete('rotated-fixture-token');
    assert.deepEqual(JSON.parse((await received)[0].toString()),{...refresh,token:'rotated-fixture-token'});
    peer.send(challenge);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,2);
    const closed=once(browser,'close');peer.close();await closed;complete('must-not-send-after-close');
    await new Promise(resolve=>setTimeout(resolve,0));assert.equal(browser.readyState,3);
  } finally {
    stop();browser.close();for(const peer of server.clients)peer.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('credential lookup failure and timeout close the browser connection without leaking credential details', async t => {
  t.mock.timers.enable({apis:['setTimeout'],now:0});
  class Socket extends EventTarget {
    readyState=1;closed:unknown[]=[];
    send(){throw new Error('Failed credentials must not be sent.');}
    close(code:number,reason:string){this.closed.push([code,reason]);this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  for(const timeout of [false,true]) {
    const socket=new Socket();
    const stop=maintainSocketAuthentication(socket as unknown as WebSocket,
      ()=>timeout?new Promise(()=>{}):Promise.reject(new Error('private credential detail')));
    socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'auth-required',protocol:1})}));
    for(let i=0;i<5;i++)await Promise.resolve();
    if(timeout)t.mock.timers.tick(10_000);
    assert.deepEqual(socket.closed,[[1008,'Sign in again to continue']]);stop();
  }
});
