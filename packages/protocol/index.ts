export const PROTOCOL_VERSION = 1 as const;
export const GAME_VERSIONS = ['firered', 'leafgreen'] as const;
export type GameVersion = typeof GAME_VERSIONS[number];
export const BUTTON_MASK = 0x03ff;
export const MAX_BATCH_FRAMES = 60;
export const FRAME_MILLISECONDS = 280896 / 16777216 * 1000;
export const HANDLE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{2,15}$/;

export class DomainError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

export function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('INVALID_MESSAGE', 'Expected an object.');
  }
}

export function gameVersion(value: unknown): GameVersion {
  if (value !== 'firered' && value !== 'leafgreen') throw new DomainError('INVALID_VERSION', 'Choose FireRed or LeafGreen.');
  return value;
}

export function trainerHandle(value: unknown): { handle: string; canonical: string } {
  if (typeof value !== 'string' || !HANDLE_PATTERN.test(value)) {
    throw new DomainError('INVALID_HANDLE', 'Use 3–16 letters, numbers or underscores, starting with a letter.');
  }
  return { handle: value, canonical: value.toLowerCase() };
}

export type InputRun = { buttons: number; frames: number };
export type InputBatch = {
  type: 'input'; protocol: 1; operationId: string; sessionId: string;
  sequence: number; startFrame: number; runs: InputRun[];
};
export type VerificationAck = {
  type: 'verified'; protocol: 1; operationId: string; sequence: number;
  frame: number; digest: string;
};
export type SessionStatus = 'adventure' | 'lobby' | 'battle' | 'trade' | 'closed';
export type PublicProfile = { id: string; handle: string };
/** Bounded lobby presence: what other trainers may see. Species and levels
 * only — no nicknames, moves, PP, digests or any cartridge bytes. */
export type PartyPreviewEntry = { species: number; name: string; level: number };
export type LobbyTrainer = PublicProfile & { version: GameVersion; party: PartyPreviewEntry[]; maxLevel: number | null };
export type LobbyTrainerPage = { trainers: LobbyTrainer[]; nextCursor: string | null };
export const LOBBY_PAGE_SIZE = 50;
export type LobbyTrainerQuery = { after: string; search: string; version?: GameVersion; minLevel?: number; maxLevel?: number };
export function lobbyTrainerQuery(value:unknown={}):LobbyTrainerQuery{
  assertRecord(value);
  const allowed=new Set(['after','search','version','minLevel','maxLevel']);
  if(Object.keys(value).some(key=>!allowed.has(key)))throw new DomainError('INVALID_TRAINER_SEARCH','Use a trainer name prefix, edition, level band and page cursor.');
  const text=(key:'after'|'search')=>{
    if(value[key]===undefined)return '';
    if(typeof value[key]!=='string'||value[key].length>32)throw new DomainError('INVALID_TRAINER_SEARCH','Use up to 16 letters, numbers or underscores.');
    const normalized=value[key].trim().toLowerCase();
    if(normalized&&!(key==='after'?HANDLE_PATTERN:/^[a-z][a-z0-9_]{0,15}$/).test(normalized))
      throw new DomainError('INVALID_TRAINER_SEARCH','Use up to 16 letters, numbers or underscores, starting with a letter.');
    return normalized;
  };
  const level=(key:'minLevel'|'maxLevel')=>{
    const raw=value[key];if(raw===undefined)return undefined;
    const parsed=typeof raw==='string'&&/^[0-9]{1,3}$/.test(raw)?Number(raw):typeof raw==='number'?raw:NaN;
    if(!Number.isSafeInteger(parsed)||parsed<1||parsed>100)throw new DomainError('INVALID_TRAINER_SEARCH','Use a party level between 1 and 100.');
    return parsed;
  };
  const version=(()=>{
    const raw=value.version;if(raw===undefined)return undefined;
    if(raw!=='firered'&&raw!=='leafgreen')throw new DomainError('INVALID_TRAINER_SEARCH','Choose FireRed or LeafGreen.');
    return raw as GameVersion;
  })();
  const minLevel=level('minLevel'),maxLevel=level('maxLevel');
  if(minLevel!==undefined&&maxLevel!==undefined&&minLevel>maxLevel)
    throw new DomainError('INVALID_TRAINER_SEARCH','The level band starts above where it ends.');
  return {after:text('after'),search:text('search'),version,minLevel,maxLevel};
}
export type AdventureSummary = {
  id: string; version: GameVersion; revision: number; updatedAt: string;
  hasSave: boolean; slot?:number;
};

export function inputBatch(value: unknown): InputBatch {
  assertRecord(value);
  const allowed = new Set(['type', 'protocol', 'operationId', 'sessionId', 'sequence', 'startFrame', 'runs']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new DomainError('INVALID_MESSAGE', 'Unexpected input fields.');
  if (value.type !== 'input' || value.protocol !== PROTOCOL_VERSION) throw new DomainError('PROTOCOL_MISMATCH', 'Refresh the game to update its protocol.');
  for (const key of ['operationId', 'sessionId'] as const) {
    if (typeof value[key] !== 'string' || value[key].length < 1 || value[key].length > 100) throw new DomainError('INVALID_MESSAGE', `Invalid ${key}.`);
  }
  for (const key of ['sequence', 'startFrame'] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) throw new DomainError('INVALID_MESSAGE', `Invalid ${key}.`);
  }
  if (!Array.isArray(value.runs) || value.runs.length < 1 || value.runs.length > MAX_BATCH_FRAMES) throw new DomainError('INVALID_INPUT', 'Invalid input batch.');
  let frames = 0;
  for (const run of value.runs) {
    assertRecord(run);
    if (Object.keys(run).some(key => key !== 'buttons' && key !== 'frames')
      || !Number.isInteger(run.buttons) || Number(run.buttons) < 0 || Number(run.buttons) > BUTTON_MASK
      || !Number.isInteger(run.frames) || Number(run.frames) < 1) throw new DomainError('INVALID_INPUT', 'Invalid button run.');
    frames += Number(run.frames);
    if (frames > MAX_BATCH_FRAMES) throw new DomainError('INVALID_INPUT', 'Input batch is too long.');
  }
  return {
    type: 'input', protocol: 1, operationId: value.operationId as string,
    sessionId: value.sessionId as string, sequence: value.sequence as number,
    startFrame: value.startFrame as number,
    runs: value.runs.map(run => ({ buttons: Number(run.buttons), frames: Number(run.frames) })),
  };
}
