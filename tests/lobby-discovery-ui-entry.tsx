// Local browser-test entry only. The test intercepts this document and its
// API module; it is never linked from the application or built for production.
import {createRoot} from 'react-dom/client';
import {Lobby} from '../apps/web/src/lobby.tsx';
import '../apps/web/src/theme.css';
import '../apps/web/src/style.css';
createRoot(document.getElementById('root')!).render(<Lobby authenticated available trading battles
  onAdventures={()=>undefined} onResume={()=>undefined} onBattle={()=>undefined}
  onWatch={(battle,side)=>{document.body.dataset.watch=`${battle.id}:${side}`;}}/>);
