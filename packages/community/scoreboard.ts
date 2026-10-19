/** Calculation policy for future server-verified community events. No public
 * score submission endpoint exists; authenticated input is not proof of play.
 * Supply the complete verified history (or equivalent first-registration data),
 * including earlier weeks, so a repeat registration cannot earn points again. */
export type CommunityEvent = {
  id: string; owner: string; occurredAt: string; verified: boolean;
} & ({kind:'badge';adventureId:string;badge:number}
  | {kind:'pokedex-owned';nationalDex:number}
  | {kind:'battle-win';battleId:string;opponent:string;format:string;outcome:'completed'|'forfeit'|'aborted'});
export const COMMUNITY_SCORE_POLICY = {id:'community-weekly-v1',badge:25,newSpecies:5,battleWin:10,battleWinsPerOpponentPerWeek:2} as const;
export function utcWeek(value: string | Date) {
  const time = new Date(typeof value === 'string' ? value : value.getTime()); if (!Number.isFinite(time.getTime())) throw new Error('Invalid scoreboard date.');
  const start = new Date(Date.UTC(time.getUTCFullYear(),time.getUTCMonth(),time.getUTCDate()));
  start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
  return {start:start.toISOString(),end:new Date(start.getTime()+7*86400000).toISOString()};
}
export function weeklyScoreboard(events: readonly CommunityEvent[], at: string | Date) {
  const week=utcWeek(at),start=Date.parse(week.start),end=Date.parse(week.end);
  const ids=new Map<string,string>(),seen=new Set<string>(),rows=new Map<string,{owner:string;points:number;badges:number;newSpecies:number;battleWins:number}>(),opponents=new Map<string,number>();
  const ordered=[...events].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.id.localeCompare(b.id,'en'));
  for (const event of ordered) {
    const encoded=JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a],[b])=>a<b?-1:a>b?1:0))),prior=ids.get(event.id);
    if (prior !== undefined) { if (prior!==encoded) throw new Error('Conflicting verified event id.'); continue; }
    ids.set(event.id,encoded);
    const occurred=Date.parse(event.occurredAt);
    if (!event.verified || !event.owner || !Number.isFinite(occurred) || occurred>=end) continue;
    let key:string,points:number,metric:'badges'|'newSpecies'|'battleWins';
    if (event.kind==='badge') {
      if (!event.adventureId || !Number.isInteger(event.badge) || event.badge<1 || event.badge>16) continue;
      key=JSON.stringify([event.owner,'badge',event.adventureId,event.badge]);points=COMMUNITY_SCORE_POLICY.badge;metric='badges';
    } else if (event.kind==='pokedex-owned') {
      if (!Number.isInteger(event.nationalDex)||event.nationalDex<1||event.nationalDex>493) continue;
      key=JSON.stringify([event.owner,'species',event.nationalDex]);points=COMMUNITY_SCORE_POLICY.newSpecies;metric='newSpecies';
    } else {
      if (!event.battleId || !event.format || !event.opponent || event.opponent===event.owner || event.outcome!=='completed') continue;
      key=JSON.stringify([event.owner,'win',event.battleId]);points=COMMUNITY_SCORE_POLICY.battleWin;metric='battleWins';
    }
    if (seen.has(key)) continue; seen.add(key);
    if (occurred<start) continue; // Earlier first registrations cannot be farmed again this week.
    if (event.kind==='battle-win') {
      const pair=JSON.stringify([event.owner,event.opponent]),count=opponents.get(pair)??0;
      if (count>=COMMUNITY_SCORE_POLICY.battleWinsPerOpponentPerWeek) continue; opponents.set(pair,count+1);
    }
    const row=rows.get(event.owner)??{owner:event.owner,points:0,badges:0,newSpecies:0,battleWins:0};
    row.points+=points;row[metric]++;rows.set(event.owner,row);
  }
  return {policy:COMMUNITY_SCORE_POLICY.id,week,rows:[...rows.values()].sort((a,b)=>b.points-a.points||(a.owner<b.owner?-1:a.owner>b.owner?1:0)),publicReady:false as const};
}
