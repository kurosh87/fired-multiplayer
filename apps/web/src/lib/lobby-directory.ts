import {LOBBY_PAGE_SIZE,type LobbyTrainer,type LobbyTrainerPage} from '../../../../packages/protocol/index.ts';
import type {LiveBattle} from '../../../../packages/battles/protocol.ts';

export type LobbyDirectoryMessage =
  |{type:'sync';trainers:LobbyTrainer[]}
  |{type:'put';trainer:LobbyTrainer}
  |{type:'del';ownerId:string};

export type LobbyPresenceMessage = LobbyDirectoryMessage|{type:'live';battles:LiveBattle[]};

/** The visible window that live events must respect: the same filters as the
 * page request plus the cursor the page was fetched after. */
export type DirectoryView={after:string;search:string;edition:string;near:boolean;myLevel:number};

const name=(trainer:{handle:string})=>trainer.handle.toLowerCase();

/** Mirrors the server-side directory filters so a live row can never outlive
 * them, even while the page poll is silent. */
export function matchesDirectory(trainer:LobbyTrainer,view:DirectoryView):boolean{
  if(view.search&&!name(trainer).startsWith(view.search.toLowerCase()))return false;
  if(view.edition&&trainer.version!==view.edition)return false;
  if(view.near&&view.myLevel>0){
    if(trainer.maxLevel===null)return false;
    if(trainer.maxLevel<Math.max(1,view.myLevel-10)||trainer.maxLevel>Math.min(100,view.myLevel+10))return false;
  }
  return true;
}

/** Applies one live event to the page on screen. The 20 s poll stays the
 * authority for paging; this only adjusts what fits the visible window. */
export function directoryMessage(page:LobbyTrainerPage,message:LobbyDirectoryMessage,view:DirectoryView):LobbyTrainerPage{
  if(message.type==='del'){
    return page.trainers.some(trainer=>trainer.id===message.ownerId)
      ?{...page,trainers:page.trainers.filter(trainer=>trainer.id!==message.ownerId)}:page;
  }
  if(message.type==='put'){
    const eligible=matchesDirectory(message.trainer,view)&&name(message.trainer)>view.after;
    const present=page.trainers.some(trainer=>trainer.id===message.trainer.id);
    if(!eligible)return present?{...page,trainers:page.trainers.filter(trainer=>trainer.id!==message.trainer.id)}:page;
    const trainers=place(page.trainers,message.trainer).slice(0,LOBBY_PAGE_SIZE);
    return {trainers,nextCursor:trainers.length===LOBBY_PAGE_SIZE?name(trainers[trainers.length-1]!):page.nextCursor};
  }
  // A fresh baseline. Rows sorting above the highest synced name cannot be
  // validated from the capped sync and stay exactly as they are.
  const trainers=message.trainers.slice().sort((left,right)=>name(left)<name(right)?-1:1);
  const horizon=trainers.length?name(trainers[trainers.length-1]!):undefined;
  let merged=horizon?page.trainers.filter(trainer=>name(trainer)>horizon):[];
  for(const trainer of trainers){
    if(matchesDirectory(trainer,view)&&name(trainer)>view.after)merged=place(merged,trainer);
  }
  merged=merged.slice(0,LOBBY_PAGE_SIZE);
  return {trainers:merged,nextCursor:merged.length===LOBBY_PAGE_SIZE?name(merged[merged.length-1]!):(horizon?page.nextCursor:null)};
}

function place(trainers:LobbyTrainer[],trainer:LobbyTrainer):LobbyTrainer[]{
  const next=trainers.filter(item=>item.id!==trainer.id);
  const at=name(trainer);
  const index=next.findIndex(item=>name(item)>at);
  if(index<0)next.push(trainer);else next.splice(index,0,trainer);
  return next;
}
