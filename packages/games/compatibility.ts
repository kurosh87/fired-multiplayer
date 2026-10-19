import { GAME_CATALOG, isGameId, type GameId } from './catalog.ts';

export type BridgePokemon = {
  nationalDex: number; form: number; egg: boolean; level: number;
  moves: readonly number[]; ability: number; heldItem: string | null;
};
export type CompatibilityProblem = { code: string; message: string; moveSlot?: number };
export type Gen3CompatibilityOracle = {
  /** Must come from a reviewed game-data adapter, never a browser request. */
  moveAllowed(species: number, move: number): boolean;
  abilityAllowed(species: number, ability: number): boolean;
};
export const ORIGINAL_151_FORMAT = {
  id: 'kanto-151-gen3-v1', status: 'proposal', generation: 3, nationalDexMax: 151,
  engine: 'original-firered-leafgreen', partyMax: 6, levels: 'earned',
  crossGenerationExecution: 'unavailable',
} as const;

/** Inspect a proposed bridge without editing or converting any save. Species
 * alone is insufficient: Gen IV changes moves, abilities, items and mechanics.
 * Passing this check is never permission to execute a transfer or ranked match. */
export function assessOriginal151(pokemon: BridgePokemon, oracle?: Gen3CompatibilityOracle) {
  const problems: CompatibilityProblem[] = [];
  const validSpecies = Number.isInteger(pokemon.nationalDex) && pokemon.nationalDex >= 1 && pokemon.nationalDex <= 151;
  if (!validSpecies)
    problems.push({code:'SPECIES_OUTSIDE_151',message:'This format accepts National Pokédex numbers 1–151.'});
  if (pokemon.form !== 0) problems.push({code:'FORM_UNSUPPORTED',message:'This form has no verified FireRed/LeafGreen conversion.'});
  if (pokemon.egg !== false) problems.push({code:'EGG_UNSUPPORTED',message:'Hatch this Pokémon before a cross-generation transfer.'});
  if (!Number.isInteger(pokemon.level) || pokemon.level < 1 || pokemon.level > 100)
    problems.push({code:'INVALID_LEVEL',message:'The Pokémon level is invalid.'});
  if (!Array.isArray(pokemon.moves) || pokemon.moves.length !== 4 || !pokemon.moves.some(move=>Number.isInteger(move)&&move>0))
    problems.push({code:'INVALID_MOVESET',message:'A Pokémon needs four move slots and at least one move.'});
  else pokemon.moves.forEach((move,moveSlot)=>{
    if (!Number.isInteger(move) || move < 0 || move > 354)
      problems.push({code:'MOVE_NOT_IN_GEN3',moveSlot,message:'Replace this move with one supported by FireRed/LeafGreen.'});
    else if (move && validSpecies && oracle && !oracle.moveAllowed(pokemon.nationalDex,move))
      problems.push({code:'MOVESET_UNSUPPORTED',moveSlot,message:'This move is not verified for this species under the target rules.'});
  });
  if (!Number.isInteger(pokemon.ability) || pokemon.ability < 1 || pokemon.ability > 77
    || (validSpecies && oracle && !oracle.abilityAllowed(pokemon.nationalDex,pokemon.ability)))
    problems.push({code:'ABILITY_UNSUPPORTED',message:'This ability has no verified target-game equivalent for this species.'});
  if (pokemon.heldItem !== null) problems.push({code:'HELD_ITEM_UNSUPPORTED',message:'Remove the held item; cross-generation item conversion is not enabled.'});
  if (!oracle) problems.push({code:'TARGET_DATA_UNVERIFIED',message:'The target species, move and ability adapter is not qualified.'});
  return { policyPass: problems.length === 0, executable: false as const, problems,
    requires: ['reviewed-native-record-converter','verified-source-ownership','atomic-source-removal-and-destination-write',
      'destination-pokedex-update','native-save-readback'] as const };
}

export function crossGenerationRoute(source: GameId, destination: GameId) {
  if (!isGameId(source) || !isGameId(destination)) return { allowedDirection:false, executable:false as const, reason:'UNKNOWN_GAME' };
  const allowedDirection = GAME_CATALOG[source].generation === 4 && GAME_CATALOG[destination].generation === 3;
  return { allowedDirection, executable:false as const, reason:allowedDirection?'CONVERTER_NOT_QUALIFIED':'DIRECTION_NOT_ALLOWED' };
}
