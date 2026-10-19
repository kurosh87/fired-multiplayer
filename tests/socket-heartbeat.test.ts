import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {monitorSocketHeartbeat,SOCKET_HEARTBEAT_MS} from '../apps/server/src/socket-heartbeat.ts';

class Socket extends EventEmitter{
  readyState=1;pings=0;terminated=0;writeError=false;throws=false;
  ping(callback:(error?:Error)=>void){this.pings++;if(this.throws)throw new Error('fixture write failure');callback(this.writeError?new Error('fixture write failure'):undefined);}
  terminate(){this.terminated++;this.readyState=3;this.emit('close');}
}

test('heartbeats keep responsive paused connections alive and terminate an unresponsive peer within two intervals',t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const socket=new Socket(),stop=monitorSocketHeartbeat(socket as unknown as WebSocket);
  try{
    for(let i=0;i<4;i++){t.mock.timers.tick(SOCKET_HEARTBEAT_MS);assert.equal(socket.pings,i+1);socket.emit('pong');assert.equal(socket.terminated,0);}
    t.mock.timers.tick(SOCKET_HEARTBEAT_MS);assert.equal(socket.terminated,0);
    t.mock.timers.tick(SOCKET_HEARTBEAT_MS);assert.equal(socket.terminated,1);
    t.mock.timers.tick(SOCKET_HEARTBEAT_MS*3);assert.equal(socket.terminated,1);assert.equal(socket.listenerCount('pong'),0);
  }finally{stop();}
});

test('heartbeat cleanup and ping write failures do not leave callbacks or repeatedly terminate a socket',t=>{
  t.mock.timers.enable({apis:['setInterval']});
  for(const kind of ['closed','disposed','write-error','throw'] as const){
    const socket=new Socket(),stop=monitorSocketHeartbeat(socket as unknown as WebSocket);
    if(kind==='closed'){socket.readyState=3;socket.emit('close');}
    if(kind==='disposed')stop();
    socket.writeError=kind==='write-error';socket.throws=kind==='throw';
    t.mock.timers.tick(SOCKET_HEARTBEAT_MS*4);
    assert.equal(socket.terminated,kind==='write-error'||kind==='throw'?1:0);
    assert.equal(socket.listenerCount('pong'),0);assert.equal(socket.listenerCount('close'),0);stop();
  }
});

test('real WebSocket ping/pong keeps a responsive peer and detects one that stops answering',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  server.on('connection',socket=>monitorSocketHeartbeat(socket));
  const address=server.address();assert(address&&typeof address!=='string');
  const healthy=new WebSocket(`ws://127.0.0.1:${address.port}`);
  const silent=new WebSocket(`ws://127.0.0.1:${address.port}`,{autoPong:false});
  try{
    await Promise.all([once(healthy,'open'),once(silent,'open')]);
    const peers=[...server.clients];assert.equal(peers.length,2);
    const [responding]=peers;
    const firstPong=once(responding!,'pong'),unansweredPing=once(silent,'ping');
    t.mock.timers.tick(SOCKET_HEARTBEAT_MS);await firstPong;await unansweredPing;
    assert.equal(healthy.readyState,WebSocket.OPEN);assert.equal(silent.readyState,WebSocket.OPEN);
    const secondPong=once(responding!,'pong'),closed=once(silent,'close');
    t.mock.timers.tick(SOCKET_HEARTBEAT_MS);await secondPong;
    assert.equal((await closed)[0],1006);assert.equal(healthy.readyState,WebSocket.OPEN);
    const healthyClosed=once(healthy,'close');healthy.close();await healthyClosed;
  }finally{
    healthy.terminate();silent.terminate();for(const peer of server.clients)peer.terminate();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
