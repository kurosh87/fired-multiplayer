// Local browser-test entry only. The test intercepts this document, the API
// module and the battle socket; it is never linked from the application.
import {createRoot} from 'react-dom/client';
import {Watch} from '../apps/web/src/watch.tsx';
import type {LiveBattle} from '../packages/battles/protocol.ts';
import '../apps/web/src/theme.css';
import '../apps/web/src/style.css';
const battle:LiveBattle={id:'00000000-0000-4000-8000-000000009999',
  playerA:{handle:'Scout001',version:'firered'},playerB:{handle:'Scout002',version:'leafgreen'},
  frame:4,startedAt:Date.now()};
createRoot(document.getElementById('root')!).render(<Watch battle={battle} side="a"
  onExit={()=>{document.body.dataset.exited='yes';}}/>);
