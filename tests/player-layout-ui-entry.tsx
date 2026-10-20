// Test-only finished state: no authentication, network or game simulation.
import { createRoot } from 'react-dom/client';
import { Battle } from '../apps/web/src/battle.tsx';
import '../apps/web/src/theme.css';
import '../apps/web/src/style.css';
const version = new URLSearchParams(location.search).get('version') === 'leafgreen' ? 'leafgreen' : 'firered';
createRoot(document.getElementById('root')!).render(<Battle battle={{
  id: '00000000-0000-4000-8000-000000000001', side: 'b', status: 'finished',
  playerA: { id: 'a', handle: 'Alice', version: 'firered' },
  playerB: { id: 'b', handle: 'Bob', version },
  rules: { format: 'singles', levels: 'earned', ranked: false }, expiresAt: 0,
  result: { winner: null, reason: 'finished' }, watchable: false,
}} onExit={() => { location.hash = 'lobby'; }} />);
