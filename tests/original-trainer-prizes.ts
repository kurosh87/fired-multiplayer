import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Independently derive ordinary singles prizes from the pinned source data.
 * This deliberately refuses unsupported party formats rather than guessing. */
export async function originalTrainerPrizes(ids:number[]){
  const paths=['vendor/pokefirered/include/constants/opponents.h','vendor/pokefirered/src/data/trainers.h',
    'vendor/pokefirered/src/data/trainer_parties.h','vendor/pokefirered/src/battle_main.c'];
  const files=await Promise.all(paths.map(path=>readFile(path,'utf8')));
  const [opponents,trainers,parties,money]=files as [string,string,string,string];
  const names=new Map([...opponents.matchAll(/^#define\s+(TRAINER_\w+)\s+(\d+)\s*$/gm)].map(match=>[Number(match[2]),match[1]!]));
  const rates=new Map([...money.matchAll(/\{(TRAINER_CLASS_\w+),\s*(\d+)\}/g)].map(match=>[match[1]!,Number(match[2])]));
  const prizes=ids.map(id=>{
    const name=names.get(id);assert(name,`Unknown trainer ${id}`);
    const block=trainers.match(new RegExp(`\\[${name}\\]\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\},`))?.[1];assert(block);
    assert(/\.doubleBattle\s*=\s*FALSE/.test(block),'Only ordinary singles prizes are supported.');
    const trainerClass=block.match(/\.trainerClass\s*=\s*(TRAINER_CLASS_\w+)/)?.[1];assert(trainerClass);
    // These two original no-held-item layouts differ only in explicit moves;
    // both declare the same scalar .lvl field used by the prize formula.
    const party=block.match(/\.party\s*=\s*NO_ITEM_(?:DEFAULT|CUSTOM)_MOVES\((\w+)\)/)?.[1];assert(party,'Require a reviewed no-held-item party format.');
    const data=parties.match(new RegExp(`${party}\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`))?.[1];assert(data);
    const levels=[...data.matchAll(/\.lvl\s*=\s*(\d+)/g)].map(match=>Number(match[1]));assert(levels.length>0&&levels.length<=6);
    const rate=rates.get(trainerClass),lastMonLevel=levels.at(-1)!;assert(rate&&lastMonLevel>=1&&lastMonLevel<=100);
    return {id,name,trainerClass,lastMonLevel,rate,prize:4*lastMonLevel*rate};
  });
  return {prizes,total:prizes.reduce((sum,trainer)=>sum+trainer.prize,0),
    sourceSha256:Object.fromEntries(paths.map((path,index)=>[path,createHash('sha256').update(files[index]!).digest('hex')]))};
}
