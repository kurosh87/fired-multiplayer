# Extended original-game adventure checks

Both experimental 16 MiB cores have recorded routes from a fresh boot through
the starter and rival, Route 1 wild battles, Viridian's parcel, the original
Pokédex and five-ball gift, a wild capture and the original Save menu. LeafGreen
also visits Viridian's Pokémon Center and heals Bulbasaur from 5 to 19 HP without
changing its experience or identity. No game code or public capability flags
changed for these checks.

| Route | Frames | Bulbasaur at save | Rattata at save | Balls used / left |
| --- | ---: | --- | --- | --- |
| FireRed | 56,843 | Level 6, 8/22 HP | Level 3, 10/15 HP | 3 / 2 |
| LeafGreen | 56,383 | Level 5, 19/19 HP | Level 3, 4/15 HP | 1 / 4 |

The pinned cores remain `firered-rev1-cd551d2c6a-32b55352a660` and
`leafgreen-rev1-cd551d2c6a-68ac436de4e8`.

Both routes earn every item and Pokémon through controller input. FireRed's first
two balls fail before its third catches Rattata; LeafGreen's first ball succeeds.
Both final saves retain the Pokédex, with no parcel remaining. The original
battle result is `CAUGHT`.

## Evidence

- `tests/replays/{firered,leafgreen}-route1-catch-save.json` contain the complete input movies.
- `build/adventure-qualification/{firered,leafgreen}-catch/report.json` record the exact
  artifact, state/save/party digests, explored lineage and recovery checks.
- The complete movie reproduces every retained exploration segment's canonical
  digest from a fresh engine, without the inspection calls used to plan the path.
- Fresh-instance Continue and the original reset chord recover the party,
  position, parcel state, Pokédex and ball count. The longer route creates a
  quest-log recap; its continuation fixture skips it through original B inputs.
- Each checksum-matching original GBA game loads its 128 KiB save and opens its
  Pokémon menu. Both 100-byte party records match exactly, including encrypted
  data and battle stats, with neither Pokémon marked as a bad egg. Independent
  GBA RAM readback also confirms the parcel is gone, Pokédex flag is set, scene is
  complete and the expected balls remain. This proves saved-game compatibility for each
  case; it does not prove full gameplay or pixel parity against the original.
- Desktop and mobile Chrome emulation run the complete movie in the actual
  browser worker with canonical digest parity against the private C replay.
  Worker replacement restores the open battle bag, the caught party and the
  final saved state; LeafGreen also restores its healed-party checkpoint. These
  checks do not establish physical-device coverage.

The independent original ROM SHA-1 values remain
`dd5945db9b930750cb39d00c84da8571feebf417` (FireRed) and
`7862c67bdecbe21d1d69ce082ce34327e1c6ed5e` (LeafGreen). Cartridge SHA-256 values
are recorded in each qualification report.
The original GBA reference uses pinned mGBA 0.10.5 solely as a test instrument;
it is not shipped in the browser.

## Reproduction

Build the pinned candidates and reference baseline first, and run finite jobs
through the project resource guard. Existing results are retained; choose a new
evidence tag/output folder when repeating checks.

```sh
KANTO_ENGINE_CANDIDATE=build/game-source/firered/memory-16 \
KANTO_ENGINE_REPLAY=tests/replays/firered-route1-catch-save.json \
KANTO_ENGINE_EVIDENCE_TAG=route1-catch \
npm run test:engine-browser -- --output test-output/engine-route1-catch

python3 -B scripts/run-reference.py --version firered \
  --save build/adventure-qualification/firered-catch/adventure.sav \
  --replay tests/replays/firered-route1-catch-continue-party.json \
  --output build/reference/firered-route1-catch
node --experimental-strip-types scripts/check-extended-readback.ts firered
```

Replace `firered` with `leafgreen` in each path and argument for the other route.

`scripts/check-extended-adventure.ts` additionally audits the retained exploration
checkpoint lineage, replays the complete movie from boot, checks immutable asset
bytes, and verifies Save/Continue/reset and complete checkpoint restoration. Its
lineage audit needs the retained `build/adventure-exploration` evidence; the
source replay can be run independently once the candidate is built.

## Inspection discipline and remaining scope

`scripts/explore-route.ts` reads geometry and records every button used to walk,
battle and select menu actions. It never grants items, modifies Pokémon or writes
game flags. Canonical digests before and after observation must match.

The original `FlagGet` and some `VarGet` calls can record quest-log observations.
They are unsuitable for passive inspection while that log records. The helper
reads those values directly at the pinned GBA-compatible SaveBlock offsets and
keeps the digest invariant. A diagnostic option audits individual read calls.
Failed exploration branches remain retained and are excluded from the qualified
movie's lineage.

Both editions' subsequent [PC deposit/withdrawal routes](STORAGE.md) check their
original-menu saves and complete storage blocks against the corresponding
original GBA game. Other PC operations remain open.

Further maps, additional healing contexts, gyms, HMs,
postgame, audio, physical devices, hosted-account journeys and distributed
1,000-player qualification remain unfinished. The Netlify site remains a
temporary solo preview; this evidence does not enable hosted persistence or
multiplayer and does not promote either core into the public engine registry.

The subsequent [Viridian Forest routes](FOREST.md) extend both audio-16 cores
through the old man's catching tutorial and Teachy TV gift, Route 2, a forest
trainer victory, Pewter healing and another original-menu save. The complete
fresh-boot movies reach 107,633 FireRed frames and 119,547 LeafGreen frames,
with canonical replay, Save/Continue and warm-reset recovery checks. That forest
route does not qualify Brock; the subsequent [first gym checks](BROCK.md) cover
training, the badge and a battle text storage repair in separate candidates.
