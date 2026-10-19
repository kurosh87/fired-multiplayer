import {createRoot} from 'react-dom/client';
import {Battle} from '../apps/web/src/battle.tsx';
import {accountCredentials} from '../apps/web/src/account-session.ts';
import type {BattleView} from '../packages/battles/protocol.ts';
import '../apps/web/src/theme.css';
import '../apps/web/src/style.css';
const fixture=(window as unknown as {requestBattleFixture:{battle:BattleView;owner:string;token:string}}).requestBattleFixture;
accountCredentials.observe({owner:fixture.owner,token:fixture.token,emailVerified:true,expiresAt:Date.now()+3600_000});
createRoot(document.getElementById('root')!).render(<Battle battle={fixture.battle} onExit={()=>{document.body.dataset.exited='true';}}/>);
