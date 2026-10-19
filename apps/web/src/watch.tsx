import { WatchPanel } from './battle-panel.tsx';
import { useEffect, useRef, useState } from 'react';
import { maintainSocketAuthentication } from './lib/socket-auth.ts';
import './battles.css';
import { API_URL, token } from './api.ts';
import { BattleScreenDecoder } from '../../../packages/battles/screen.ts';
import type { BattleView, LiveBattle, WatchSide } from '../../../packages/battles/protocol.ts';
import type { BattleResult } from '../../../packages/battles/session.ts';

/** Spectating is a read-only socket: the same rendered pixels an owner gets,
 * with no controls, party, saves or server journals in the client. */
export function Watch({ battle, side: initialSide = 'a', onExit }: { battle: LiveBattle; side?: WatchSide; onExit(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [side, setSide] = useState<WatchSide>(initialSide);
  const [result, setResult] = useState<BattleResult | null>(null);
  const [message, setMessage] = useState('Connecting to the live battle…');
  const [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const finished = useRef(false);
  useEffect(() => {
    finished.current = false;
    setResult(null); setError(''); setMessage('Connecting to the live battle…');
    let mounted = true, socket: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined, stopAuthentication: (() => void) | undefined;
    let failures = 0;
    const stop = (text: string) => { finished.current = true; setMessage(text); };
    async function connect() {
      if (!mounted || finished.current) return;
      try {
        const accessToken = await token(); if (!mounted) return;
        const url = new URL('/api/battle-play', API_URL); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const decoder = new BattleScreenDecoder(), picture = new ImageData(decoder.pixels, 240, 160), connection = new WebSocket(url);
        socket = connection; connection.binaryType = 'arraybuffer';
        stopAuthentication?.(); stopAuthentication = maintainSocketAuthentication(connection, token);
        connection.onopen = () => connection.send(JSON.stringify({ type: 'authenticate', protocol: 1, token: accessToken, battleId: battle.id, watch: { side } }));
        connection.onmessage = event => {
          if (!mounted || socket !== connection) return;
          try {
            if (event.data instanceof ArrayBuffer) {
              if (decoder.apply(new Uint8Array(event.data))) canvas.current?.getContext('2d')?.putImageData(picture, 0, 0);
              return;
            }
            const body = JSON.parse(event.data);
            if (body.type === 'ready') {
              if (!body.battle || body.battle.id !== battle.id || body.battle.side !== side) throw new Error('This battle could not be watched.');
              failures = 0; setError(''); setMessage('Watching live · read-only.');
            } else if (body.type === 'finished') {
              finished.current = true; setResult(body.result); setMessage('The battle has ended.'); connection.close();
            } else if (body.type === 'error') {
              setError(body.message); connection.close();
            } else if (body.type === 'auth-required' || body.type === 'auth-refreshed') { /* Shared authentication handler. */ }
            else throw new Error('Unsupported watch message.');
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Could not keep watching this battle.');
            connection.close();
          }
        };
        connection.onclose = event => {
          if (!mounted || socket !== connection) return;
          if (finished.current) return;
          if (event.code === 1012) { stop('The server is restoring this battle. Try again in a moment.'); return; }
          if (event.code === 1013) { setError('This battle is not accepting watchers right now.'); setMessage('Watching stopped.'); return; }
          if (event.code === 1008) {
            setError(current => current || (event.reason === 'Watch resumed in another window'
              ? 'Watching moved to another window.' : 'Watching stopped. Return to the lobby to watch again.'));
            setMessage('Watching stopped.'); return;
          }
          setMessage('Reconnecting… The battle continues without you.');
          retry = setTimeout(() => void connect(), Math.min(10_000, 1000 * 2 ** Math.min(failures++, 4)));
        };
        connection.onerror = () => connection.close();
      } catch (failure) {
        if (!mounted) return;
        setError(failure instanceof Error ? failure.message : 'Could not connect to this battle.');
        retry = setTimeout(() => void connect(), Math.min(10_000, 1000 * 2 ** Math.min(failures++, 4)));
      }
    }
    void connect();
    return () => {
      mounted = false; clearTimeout(retry); stopAuthentication?.(); socket?.close();
    };
  }, [battle.id, side, attempt]);
  return <WatchPanel battle={battle} side={side} canvasRef={canvas} result={result} message={message} error={error}
    onExit={onExit} onSwitchSide={() => setSide(current => current === 'a' ? 'b' : 'a')} onReconnect={() => setAttempt(value => value + 1)} />;
}
