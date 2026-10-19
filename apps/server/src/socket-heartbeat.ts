import type { WebSocket } from 'ws';

export const SOCKET_HEARTBEAT_MS = 30_000;

/** Protocol-level pongs need no game frames or browser timer. Terminate a
 * broken transport so its normal close handler can checkpoint and retire. */
export function monitorSocketHeartbeat(socket: WebSocket): () => void {
  let awaitingPong = false, stopped = false;
  const pong = () => { awaitingPong = false; };
  const stop = () => {
    stopped = true; clearInterval(timer);
    socket.removeListener('pong', pong); socket.removeListener('close', stop);
  };
  const broken = () => { if (!stopped) { stop(); socket.terminate(); } };
  const timer = setInterval(() => {
    if (stopped) return;
    if (socket.readyState !== 1) { stop(); return; }
    if (awaitingPong) { broken(); return; }
    awaitingPong = true;
    try { socket.ping((error?:Error) => { if (error) broken(); }); } catch { broken(); }
  }, SOCKET_HEARTBEAT_MS).unref();
  socket.on('pong', pong); socket.on('close', stop);
  return stop;
}
