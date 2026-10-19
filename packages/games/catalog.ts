/** Platform game ids are deliberately broader than the playable GBA protocol.
 * Research entries must never be accepted as existing GBA save/engine versions. */
export const GAME_IDS = ['firered','leafgreen','heartgold','soulsilver'] as const;
export type GameId = typeof GAME_IDS[number];
export type Generation = 3 | 4;
export const GAME_CATALOG = {
  firered: { name: 'FireRed', generation: 3, platform: 'gba', browser: 'experimental', region: 'kanto' },
  leafgreen: { name: 'LeafGreen', generation: 3, platform: 'gba', browser: 'experimental', region: 'kanto' },
  heartgold: { name: 'HeartGold', generation: 4, platform: 'nds', browser: 'research', region: 'johto-kanto' },
  soulsilver: { name: 'SoulSilver', generation: 4, platform: 'nds', browser: 'research', region: 'johto-kanto' },
} as const satisfies Record<GameId,{name:string;generation:Generation;platform:string;browser:string;region:string}>;
export function isGameId(value: unknown): value is GameId {
  return typeof value === 'string' && (GAME_IDS as readonly string[]).includes(value);
}
