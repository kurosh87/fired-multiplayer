import { assertRecord, BUTTON_MASK, DomainError } from '../protocol/index.ts';
import { battleId, type BattleView } from './protocol.ts';
import type { BattleResult, Side } from './session.ts';

export const REQUEST_INPUT_FRAMES = 15;
export const REQUEST_INPUT_LEAD = 30;
export type RequestBattleController = { connectionId: string; epoch: number };
export function requestBattleController(value: unknown): RequestBattleController {
  assertRecord(value);
  if (Object.keys(value).some(key => !['connectionId','epoch'].includes(key))
    || !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1)
    throw new DomainError('INVALID_BATTLE_CONTROLLER','Open a battle control connection first.');
  return { connectionId: battleId(value.connectionId), epoch: Number(value.epoch) };
}
export type RequestBattleInput = { protocol: 1; operationId: string; sequence: number;
  controller: RequestBattleController; action: 'step' | 'forfeit'; runs: { buttons: number; frames: number }[] };
export type RequestBattleMetadata = { protocol: 1; battleId: string; operationId: string;
  controller: RequestBattleController; sequence: number; nextSequence: number; side: Side; frame: number; inputThrough: number; result: BattleResult | null };
export type RequestBattleBootstrap = { protocol: 1; battle: BattleView; frame: number; nextSequence: number; inputThrough: number; controllerEpoch:number };
export type RequestBattleConnection = RequestBattleBootstrap & { controller: RequestBattleController };
export function requestBattleInput(value: unknown): RequestBattleInput {
  assertRecord(value);
  if (Object.keys(value).some(key => !['protocol', 'operationId', 'sequence', 'controller', 'action', 'runs'].includes(key))
    || value.protocol !== 1 || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0
    || !Array.isArray(value.runs) || value.runs.length > REQUEST_INPUT_FRAMES
    || typeof value.action!=='string' || !['step', 'forfeit'].includes(value.action))
    throw new DomainError('INVALID_BATTLE_REQUEST', 'Send a valid battle request.');
  const operationId = battleId(value.operationId), runs: RequestBattleInput['runs'] = [];
  let total = 0;
  for (const run of value.runs) {
    assertRecord(run);
    if (Object.keys(run).some(key => !['buttons', 'frames'].includes(key))
      || !Number.isInteger(run.buttons) || Number(run.buttons) < 0 || Number(run.buttons) > BUTTON_MASK
      || !Number.isInteger(run.frames) || Number(run.frames) < 1 || Number(run.frames) > REQUEST_INPUT_FRAMES)
      throw new DomainError('INVALID_BATTLE_REQUEST', 'Send valid personal button inputs.');
    total += Number(run.frames); runs.push({ buttons: Number(run.buttons), frames: Number(run.frames) });
  }
  if (total > REQUEST_INPUT_FRAMES || value.action === 'forfeit' && total)
    throw new DomainError('INVALID_BATTLE_REQUEST', 'A request can queue at most fifteen input frames.');
  return { protocol: 1, operationId, sequence: Number(value.sequence), controller: requestBattleController(value.controller), action: value.action as RequestBattleInput['action'], runs };
}

const MAGIC = 0x3152424b, HEADER = 12, MAX_PACKET = 153624, MAX_PACKETS = 17, MAX_METADATA = 2048;
export const MAX_BATTLE_RESPONSE_BYTES = HEADER + MAX_METADATA + MAX_PACKETS * (4 + MAX_PACKET);
export function encodeBattleResponse(metadata: RequestBattleMetadata, packets: Uint8Array[]): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  if (json.length > MAX_METADATA || packets.length > MAX_PACKETS || packets.some(packet => !packet.length || packet.length > MAX_PACKET))
    throw new Error('Battle response exceeds its bounded format.');
  const bytes = new Uint8Array(HEADER + json.length + packets.reduce((sum, packet) => sum + 4 + packet.length, 0));
  const view = new DataView(bytes.buffer); view.setUint32(0, MAGIC, true); view.setUint32(4, json.length, true); view.setUint32(8, packets.length, true);
  bytes.set(json, HEADER); let offset = HEADER + json.length;
  for (const packet of packets) { view.setUint32(offset, packet.length, true); bytes.set(packet, offset + 4); offset += 4 + packet.length; }
  return bytes;
}
export function decodeBattleResponse(bytes: Uint8Array): { metadata: RequestBattleMetadata; packets: Uint8Array[] } {
  if (bytes.length < HEADER || bytes.length > MAX_BATTLE_RESPONSE_BYTES) throw new Error('Invalid battle response size.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), size = view.getUint32(4, true), count = view.getUint32(8, true);
  if (view.getUint32(0, true) !== MAGIC || size > MAX_METADATA || size < 2 || count > MAX_PACKETS || HEADER + size > bytes.length)
    throw new Error('Invalid battle response header.');
  const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEADER, HEADER + size)));
  assertRecord(metadata); battleId(metadata.battleId); battleId(metadata.operationId); requestBattleController(metadata.controller);
  if (Object.keys(metadata).some(key => !['protocol','battleId','operationId','controller','sequence','nextSequence','side','frame','inputThrough','result'].includes(key))
    || metadata.protocol !== 1 || !['a','b'].includes(String(metadata.side))
    || !['sequence','nextSequence','frame','inputThrough'].every(key => Number.isSafeInteger(metadata[key]) && Number(metadata[key]) >= 0)
    || metadata.nextSequence !== Number(metadata.sequence) + 1 || Number(metadata.inputThrough) < Number(metadata.frame) || Number(metadata.inputThrough)>Number(metadata.frame)+REQUEST_INPUT_LEAD
    || metadata.result !== null && (typeof metadata.result !== 'object' || Array.isArray(metadata.result))) throw new Error('Invalid battle response metadata.');
  if (metadata.result !== null) {
    assertRecord(metadata.result);
    if (Object.keys(metadata.result).some(key => !['winner','reason'].includes(key)) || !['a','b',null].includes(metadata.result.winner as Side | null)
      || !['finished','forfeit','disconnect','timeout','engine_error'].includes(String(metadata.result.reason))) throw new Error('Invalid battle response result.');
  }
  let offset = HEADER + size; const packets: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    if (offset + 4 > bytes.length) throw new Error('Truncated battle packet length.');
    const length = view.getUint32(offset, true); offset += 4;
    if (length < 1 || length > MAX_PACKET || offset + length > bytes.length) throw new Error('Invalid battle packet length.');
    packets.push(bytes.subarray(offset, offset + length)); offset += length;
  }
  if (offset !== bytes.length) throw new Error('Unexpected battle response bytes.');
  return { metadata: metadata as RequestBattleMetadata, packets };
}
