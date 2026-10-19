import {test} from 'node:test';
import assert from 'node:assert/strict';
import {directoryMessage,matchesDirectory,type DirectoryView} from '../apps/web/src/lib/lobby-directory.ts';
import type {LobbyTrainer,LobbyTrainerPage} from '../packages/protocol/index.ts';

const view=(values:Partial<DirectoryView>={}):DirectoryView=>({after:'',search:'',edition:'',near:false,myLevel:0,...values});
const trainer=(handle:string,values:Partial<LobbyTrainer>={}):LobbyTrainer=>(
  {id:`id-${handle}`,handle,version:'firered',party:[],maxLevel:null,...values});
const page=(handles:string[],values:Partial<LobbyTrainerPage>={}):LobbyTrainerPage=>(
  {trainers:handles.map(handle=>trainer(handle)),nextCursor:null,...values});
const handles=(value:LobbyTrainerPage)=>value.trainers.map(item=>item.handle);

test('a live entry slots into name order and updates in place',()=>{
  const start=page(['Bravo','Delta']);
  const inserted=directoryMessage(start,{type:'put',trainer:trainer('Charlie')},view());
  assert.deepEqual(handles(inserted),['Bravo','Charlie','Delta']);
  const first=directoryMessage(inserted,{type:'put',trainer:trainer('Alpha')},view());
  assert.deepEqual(handles(first),['Alpha','Bravo','Charlie','Delta']);
  const updated=directoryMessage(first,{type:'put',trainer:trainer('Bravo',{maxLevel:42,party:[{species:1,name:'BULBASAUR',level:42}]})},view());
  assert.deepEqual(handles(updated),['Alpha','Bravo','Charlie','Delta']);
  assert.equal(updated.trainers[1]!.maxLevel,42);
  assert.deepEqual(updated.trainers[1]!.party,[{species:1,name:'BULBASAUR',level:42}]);
});

test('a live entry can never outlive the active filters or page cursor',()=>{
  const filtered=directoryMessage(page(['Scout001']),{type:'put',trainer:trainer('Rival')},view({search:'scout'}));
  assert.deepEqual(handles(filtered),['Scout001']);
  const dropped=directoryMessage(page(['Rival','Scout001']),{type:'put',trainer:trainer('Rival')},view({search:'scout'}));
  assert.deepEqual(handles(dropped),['Scout001']);
  const edition=directoryMessage(page(['Scout001']),{type:'put',trainer:trainer('Scout002',{version:'leafgreen'})},view({edition:'firered'}));
  assert.deepEqual(handles(edition),['Scout001']);
  const behind=directoryMessage(page(['Zulu']),{type:'put',trainer:trainer('Alpha')},view({after:'mike'}));
  assert.deepEqual(handles(behind),['Zulu']);
  const near=directoryMessage(page([]),{type:'put',trainer:trainer('Scout009',{maxLevel:31})},view({near:true,myLevel:20}));
  assert.deepEqual(near.trainers,[]);
  const within=directoryMessage(page([]),{type:'put',trainer:trainer('Scout009',{maxLevel:30})},view({near:true,myLevel:20}));
  assert.deepEqual(handles(within),['Scout009']);
  const unknown=directoryMessage(page([]),{type:'put',trainer:trainer('Scout009')},view({near:true,myLevel:20}));
  assert.deepEqual(unknown.trainers,[]);
});

test('departures remove exactly one row and ignore strangers',()=>{
  const start=page(['Alpha','Bravo']);
  const removed=directoryMessage(start,{type:'del',ownerId:'id-Bravo'},view());
  assert.deepEqual(handles(removed),['Alpha']);
  const stranger=directoryMessage(removed,{type:'del',ownerId:'id-Nowhere'},view());
  assert.equal(stranger,removed,'An unknown departure must not rebuild the page.');
});

test('a full page recomputes its next cursor around live edits',()=>{
  const fifty=Array.from({length:50},(_,index)=>`Scout${String(index+1).padStart(2,'0')}`);
  const start=page(fifty.slice(0,49));
  const filled=directoryMessage(start,{type:'put',trainer:trainer(fifty[49]!)},view());
  assert.equal(filled.trainers.length,50);
  assert.equal(filled.nextCursor,'scout50');
  const squeezed=directoryMessage(filled,{type:'put',trainer:trainer('Scout00')},view());
  assert.deepEqual(handles(squeezed).slice(0,3),['Scout00','Scout01','Scout02']);
  assert.equal(squeezed.trainers.length,50);
  assert.equal(squeezed.nextCursor,'scout49','The last visible name became the new cursor.');
});

test('a sync replaces the covered window and keeps rows above its horizon',()=>{
  const replaced=directoryMessage(page(['Alpha','Bravo','Charlie']),{type:'sync',trainers:[trainer('Alpha'),trainer('Charlie')]},view());
  assert.deepEqual(handles(replaced),['Alpha','Charlie']);
  const capped=directoryMessage(page(['Alpha','Zulu']),{type:'sync',trainers:[trainer('Alpha'),trainer('Bravo')]},view());
  assert.deepEqual(handles(capped),['Alpha','Bravo','Zulu']);
  const empty=directoryMessage(page(['Alpha','Bravo']),{type:'sync',trainers:[]},view());
  assert.deepEqual(empty,{trainers:[],nextCursor:null});
  const filtered=directoryMessage(page([]),{type:'sync',trainers:[trainer('Alice'),trainer('Bob',{version:'leafgreen'})]},view({edition:'firered'}));
  assert.deepEqual(handles(filtered),['Alice']);
  const paged=directoryMessage(page([]),{type:'sync',trainers:[trainer('Alpha'),trainer('Zulu')]},view({after:'mike'}));
  assert.deepEqual(handles(paged),['Zulu']);
  const sorted=directoryMessage(page([]),{type:'sync',trainers:[trainer('Zulu'),trainer('Alpha')]},view());
  assert.deepEqual(handles(sorted),['Alpha','Zulu']);
});

test('directory filters mirror the server exactly',()=>{
  assert.equal(matchesDirectory(trainer('Scout001'),view({search:'scout'})),true);
  assert.equal(matchesDirectory(trainer('Scout001'),view({search:'SCOUT'})),true);
  assert.equal(matchesDirectory(trainer('Scout001'),view({search:'cout'})),false);
  assert.equal(matchesDirectory(trainer('Scout001',{version:'leafgreen'}),view({edition:'firered'})),false);
  assert.equal(matchesDirectory(trainer('Scout001',{maxLevel:null}),view({near:true,myLevel:20})),false);
  assert.equal(matchesDirectory(trainer('Scout001',{maxLevel:9}),view({near:true,myLevel:20})),false);
  assert.equal(matchesDirectory(trainer('Scout001',{maxLevel:10}),view({near:true,myLevel:20})),true);
  assert.equal(matchesDirectory(trainer('Scout001',{maxLevel:30}),view({near:true,myLevel:20})),true);
  assert.equal(matchesDirectory(trainer('Scout001',{maxLevel:31}),view({near:true,myLevel:20})),false);
});
