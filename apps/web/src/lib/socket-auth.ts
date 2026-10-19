/** The server asks for current browser credentials before its authorization
 * lease expires. Tokens stay in the WebSocket body, never URLs or diagnostics. */
export function maintainSocketAuthentication(connection: WebSocket, currentToken: () => Promise<string>): () => void {
  let disposed = false, pending = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    disposed = true;
    clearTimeout(deadline);
    connection.removeEventListener('message', message);
    connection.removeEventListener('close', stop);
  };
  const message = (event: MessageEvent) => {
    if (disposed || pending || typeof event.data !== 'string') return;
    let body: { type?: string; protocol?: number };
    try { body = JSON.parse(event.data); } catch { return; }
    if (!body || body.type !== 'auth-required' || body.protocol !== 1) return;
    pending = true;
    deadline = setTimeout(() => {
      stop(); connection.close(1008, 'Sign in again to continue');
    }, 10_000);
    void Promise.resolve().then(() => disposed ? undefined : currentToken()).then(accessToken => {
      if (!disposed && connection.readyState === 1)
        connection.send(JSON.stringify({ type: 'refresh-auth', protocol: 1, token: accessToken }));
    }).catch(() => {
      if (!disposed) { stop(); connection.close(1008, 'Sign in again to continue'); }
    }).finally(() => { clearTimeout(deadline); pending = false; });
  };
  connection.addEventListener('message', message);
  connection.addEventListener('close', stop);
  return stop;
}
