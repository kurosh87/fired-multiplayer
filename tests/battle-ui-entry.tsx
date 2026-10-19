// Opt-in isolated local qualification only; never a published application route.
import {useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {Lobby} from '../apps/web/src/lobby.tsx';
import {Battle} from '../apps/web/src/battle.tsx';
import type {BattleView} from '../packages/battles/protocol.ts';
import '../apps/web/src/theme.css';
import '../apps/web/src/style.css';
function Qualification(){
  const [battle,setBattle]=useState<BattleView>();
  return battle?<Battle battle={battle} onExit={()=>setBattle(undefined)}/>:<Lobby authenticated available battles onBattle={setBattle} onAdventures={()=>undefined} onResume={()=>undefined}/>;
}
const state=globalThis as typeof globalThis&{battleQualificationRoot?:Root};
state.battleQualificationRoot??=createRoot(document.getElementById('root')!);
state.battleQualificationRoot.render(<Qualification/>);
