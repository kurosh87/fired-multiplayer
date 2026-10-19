// Served only by the opt-in local browser qualification. This is not an app
// route, auth bypass, account service, or published artifact.
import { useState } from 'react';
import { createRoot,type Root } from 'react-dom/client';
import { Lobby } from '../apps/web/src/lobby.tsx';
import { Game } from '../apps/web/src/game.tsx';
import { Button } from '../apps/web/src/components/ui/button.tsx';
import type { SessionBootstrap } from '../apps/server/src/sessions.ts';
import type { TradeSceneBootstrap } from '../apps/server/src/trade-scenes.ts';
import '../apps/web/src/theme.css';
import '../apps/web/src/style.css';
function TradeQualification() {
  const query=new URLSearchParams(location.search),version=query.get('version')==='leafgreen'?'leafgreen':'firered';
  const [view,setView]=useState<'game'|'lobby'|'home'>(query.get('journey')==='1'?'game':'lobby');
  const [boot,setBoot]=useState<SessionBootstrap|TradeSceneBootstrap>();
  if(view==='game')return <Game version={boot?.manifest.version??version} initialBootstrap={boot}
    onExit={()=>{setBoot(undefined);setView(boot&&'mode' in boot?'lobby':'home');}}
    onLobby={boot&&'mode' in boot?undefined:()=>{setBoot(undefined);setView('lobby');}}/>;
  if(view==='lobby')return <Lobby authenticated available trading onAdventures={()=>setView('home')} onResume={value=>{setBoot(value);setView('game');}}/>;
  return <Button onClick={()=>{setBoot(undefined);setView('game');}}>Resume adventure</Button>;
}
const state=globalThis as typeof globalThis & {tradeQualificationRoot?:Root};
state.tradeQualificationRoot??=createRoot(document.getElementById('root')!);
state.tradeQualificationRoot.render(<TradeQualification/>);
