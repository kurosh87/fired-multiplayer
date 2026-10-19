import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DomainError, GAME_VERSIONS, type GameVersion } from '../protocol/index.ts';
import { WasmEngine, type EngineManifest, type GameEngine } from './runtime.ts';
import { createCheckpointBaseline, encodeCheckpoint, decodeCheckpoint, maxCheckpointBytes } from './checkpoint.ts';
import { prepareLobbySave, inspectLobbyParty, type PreparedLobby, type LobbyPokemon } from '../trading/prepare-lobby.ts';
import { OriginalTradeCore } from '../trading/original-core.ts';
import type { CanonicalSave } from '../trading/atomic-trade.ts';
import {BATTLE_CORE_EXPORTS} from '../battles/original-core.ts';

export type ArtifactStatus = { version: GameVersion; available: boolean; reason: string; manifest?: EngineManifest };
export type BattleArtifactPins = Readonly<Record<GameVersion,Readonly<Pick<EngineManifest,'id'|'wasmSha256'|'upstreamCommit'>>>>;

export class EngineRegistry {
  private artifacts = new Map<GameVersion, { manifest: EngineManifest; bytes: Uint8Array; checkpointBase: Uint8Array }>();
  private statuses: ArtifactStatus[] = [];

  async load(directory: string, publicRelease: boolean, capability:'adventure'|'battle'='adventure'): Promise<void> {
    return this.loadArtifacts(directory,publicRelease,capability);
  }

  /** Explicit private qualification admission. Experimental manifests retain
   * their public capability gates; every private artifact must match a pin.
   * The Netlify boundary additionally rejects production deployments. */
  async loadPrivateBattle(directory:string,pins:BattleArtifactPins):Promise<void>{
    return this.loadArtifacts(directory,false,'battle',pins);
  }

  private async loadArtifacts(directory:string,publicRelease:boolean,capability:'adventure'|'battle',pins?:BattleArtifactPins):Promise<void>{
    this.artifacts.clear();
    this.statuses = [];
    for (const version of GAME_VERSIONS) {
      try {
        const manifest = JSON.parse(await readFile(resolve(directory, `${version}.json`), 'utf8')) as EngineManifest;
        if (manifest.version !== version || manifest.revision !== 1 || manifest.abi !== 1
          || !/^[a-z0-9][a-z0-9._-]{2,99}$/.test(manifest.id)
          || !/^[a-f0-9]{64}$/.test(manifest.wasmSha256)
          || !/^[a-f0-9]{40}$/.test(manifest.upstreamCommit)
          || !['experimental', 'verified'].includes(manifest.status)
          || (!pins && manifest.capabilities?.[capability] !== true)) throw new Error('Invalid artifact manifest.');
        if(pins && (capability!=='battle' || !pins[version] || manifest.id!==pins[version].id
          || manifest.wasmSha256!==pins[version].wasmSha256 || manifest.upstreamCommit!==pins[version].upstreamCommit))
          throw new Error('The private battle artifact does not match its qualification pin.');
        if (publicRelease && manifest.status !== 'verified') throw new Error('Public play requires a verified game artifact.');
        const bytes = new Uint8Array(await readFile(resolve(directory, `${version}.wasm`)));
        const probe = await WasmEngine.create(bytes, manifest, 0);
        try{if(capability==='battle')probe.bindExtension('kanto_battle_abi_version',1,BATTLE_CORE_EXPORTS);}
        finally{probe.close();}
        const checkpointBase = await createCheckpointBaseline(await WebAssembly.compile(bytes));
        this.artifacts.set(version, { manifest, bytes, checkpointBase });
        this.statuses.push({ version, available: true, reason: pins?'private qualification only':'ready', manifest });
      } catch (error) {
        this.statuses.push({ version, available: false, reason: error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'The FireRed/LeafGreen WASM port has not been built and verified.'
          : error instanceof Error ? error.message : 'Invalid game artifact.' });
      }
    }
  }

  status(): ArtifactStatus[] { return this.statuses.map(status => ({ ...status })); }

  manifest(version: GameVersion): EngineManifest {
    const artifact = this.artifacts.get(version);
    if (!artifact) throw new DomainError('ENGINE_UNAVAILABLE', 'The game port is not ready. No adventure has been created.', 503);
    return artifact.manifest;
  }

  artifact(version: GameVersion): Uint8Array {
    this.manifest(version);
    return this.artifacts.get(version)!.bytes;
  }

  checkpointLimit(version: GameVersion): number {
    this.manifest(version);
    return maxCheckpointBytes(this.artifacts.get(version)!.checkpointBase.byteLength);
  }

  encodeCheckpoint(version: GameVersion, memory: Uint8Array): Uint8Array {
    const manifest = this.manifest(version);
    return encodeCheckpoint(memory, this.artifacts.get(version)!.checkpointBase, manifest.wasmSha256);
  }

  decodeCheckpoint(version: GameVersion, payload: Uint8Array): Uint8Array {
    const manifest = this.manifest(version);
    return decodeCheckpoint(payload, this.artifacts.get(version)!.checkpointBase, manifest.wasmSha256, { allowLegacy: true });
  }

  async create(version: GameVersion, seed: number, save?: Uint8Array): Promise<GameEngine> {
    const manifest = this.manifest(version);
    return WasmEngine.create(this.artifact(version), manifest, seed, save);
  }

  async prepareLobby(version: GameVersion, seed: number, verifiedSnapshot: Uint8Array): Promise<PreparedLobby> {
    return prepareLobbySave(this.artifact(version), this.manifest(version), seed, verifiedSnapshot);
  }
  async lobbyParty(version: GameVersion, seed: number, flash: Uint8Array): Promise<LobbyPokemon[]> {
    return inspectLobbyParty(this.artifact(version), this.manifest(version), seed, flash);
  }
  async tradeChecks(a: CanonicalSave, b: CanonicalSave, slotA: number, slotB: number): Promise<{ a: number; b: number }> {
    const first = await OriginalTradeCore.create(this.artifact(a.version), this.manifest(a.version), 0, a.flash);
    let second: OriginalTradeCore | undefined;
    try {
      second = await OriginalTradeCore.create(this.artifact(b.version), this.manifest(b.version), 0, b.flash);
      const packetA = first.packet(), packetB = second.packet();
      first.receive(packetB); second.receive(packetA);
      return { a: first.eligibility(slotA, slotB), b: second.eligibility(slotB, slotA) };
    } finally { first.close(); second?.close(); }
  }
}
