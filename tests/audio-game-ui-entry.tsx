// Opt-in local qualification entry. Never imported by an application route.
import { useState } from 'react';
import { createRoot,type Root } from 'react-dom/client';
import { Button } from '../apps/web/src/components/ui/button.tsx';
import { Game } from '../apps/web/src/game.tsx';
import { Lobby } from '../apps/web/src/lobby.tsx';
import type { SessionBootstrap } from '../apps/server/src/sessions.ts';
import type { TradeSceneBootstrap } from '../apps/server/src/trade-scenes.ts';
import '../apps/web/src/theme.css';
import '../apps/web/src/style.css';

function AudioGameQualification(){
  const version=new URLSearchParams(location.search).get('version')==='leafgreen'?'leafgreen':'firered';
  const [view,setView]=useState<'game'|'home'|'lobby'>('game');
  const [bootstrap,setBootstrap]=useState<SessionBootstrap|TradeSceneBootstrap>();
  if(view==='game')return <Game version={version} initialBootstrap={bootstrap} onExit={()=>setView('home')} onLobby={()=>setView('lobby')}/>;
  if(view==='lobby')return <Lobby authenticated available onAdventures={()=>setView('home')} onResume={boot=>{setBootstrap(boot);setView('game');}}/>;
  return <Button onClick={()=>{setBootstrap(undefined);setView('game');}}>Resume adventure</Button>;
}
const qualification=globalThis as typeof globalThis&{audioGameQualificationRoot?:Root;audioGameEntryExecutions?:number};
qualification.audioGameEntryExecutions=(qualification.audioGameEntryExecutions??0)+1;
qualification.audioGameQualificationRoot??=createRoot(document.getElementById('root')!);
qualification.audioGameQualificationRoot.render(<AudioGameQualification/>);
