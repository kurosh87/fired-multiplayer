# Route 3 and Mt. Moon verification

The recorded continuation uses the repaired `battle-text-audio-16` cores and
starts from each edition's qualified first-gym adventure. Every gameplay change
comes from recorded controller input. The route receives the running shoes,
wins Route 3 trainer battles, declines the level-15 replacement moves, naturally
evolves Bulbasaur into Ivysaur, heals, and saves outside Mt. Moon. It then
crosses the cave, defeats Team Rocket and Miguel, selects the Dome Fossil,
reaches Cerulean City, heals and saves through the original menu.

FireRed's exploration reaches 342,123 frames; LeafGreen's reaches 383,908.
Both finish with the original starter's personality and trainer ID, a level-19
Ivysaur, and the same caught Rattata. FireRed wins an additional optional Rocket
battle; LeafGreen's accepted route goes around that room. Earlier failed routes
remain retained and are excluded from the accepted input lineage.

| Edition | New frames after the first gym | Money at the final save | New trainer rewards |
| --- | ---: | ---: | ---: |
| FireRed | 130,636 | 6864 | 2056 |
| LeafGreen | 130,865 | 6368 | 1640 |

Each save contains exactly one Dome Fossil and one recorded evolution, with
the Boulder Badge, TM39 and complete PC storage preserved. Both complete C
histories and independent original-GBA save readbacks have passed.

## Qualification workflow

`scripts/check-mtmoon-adventure.ts` checks the complete new lineage and replays
its entire history from a fresh boot, including the previously qualified movie.
It requires the earlier first-gym digest and every new segment's digest to
match, without restoring exploration state. It checks immutable assets, the
first badge and TM39, the starter's identity and natural evolution counter,
the fossil item and flags, the caught Pokémon, all PC storage, and the original
Save/Continue, warm reset and checkpoint restoration paths.

`tests/original-trainer-prizes.ts` independently derives ordinary singles prizes
from the pinned trainer records, party levels and class rates. The chapter's
money increase must match those rewards exactly. Unsupported party formats are
rejected. The reader does not change the game or its prize calculation.

The exploration helper now has explicit move-learning choices, bounded dialogue
advancement, optional species-specific move selection, and optional navigation
across the original directional ledges. It only records buttons and reads game
state. Actual battles, evolution, ledge jumps and field scripts still run in the
unchanged original C. Every observation must leave the canonical digest intact.
The helper also retains a failed plan's actual inputs, checkpoint and image for
diagnosis. Those results are never silently accepted as a qualified route.

Run finite work through the resource guard and choose fresh output tags:

```sh
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/check-mtmoon-adventure.ts firered cerulean-save-v1 firered-your-fresh-tag
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/check-mtmoon-readback.ts firered firered-your-fresh-tag
```

The first command requires the retained exploration lineage. Its complete output
movie can subsequently replay without that lineage. The second loads the exact
saved cartridge into the checksum-matching original GBA game using the pinned
native reference. It checks Continue, every party byte, all 14 PC boxes, and the
selected native flags, counters, items, position and money. A native save proof
does not establish full gameplay pixel or audio parity.

Browser verification uses `KANTO_ENGINE_CONTINUATION` with the output's `browser`
fixture, `KANTO_ENGINE_AUDIO=1`, and `playwright.engine.config.ts`. It starts from
the already qualified same-artifact first-gym checkpoint and runs every new
input in the actual worker. Each batch must match the private C replay; route
milestones replace the worker from a checkpoint. Desktop and mobile Chrome
emulation are separate cases. The browser and native results must be inspected
and joined by `scripts/finalize-mtmoon-evidence.ts` before calling the chapter
qualified. Exploration endpoints and unexecuted commands alone are not proof.

Repeat with LeafGreen's corresponding paths and the `leafgreen-your-fresh-tag`
output. Retain browser logs as `build/{version}-your-fresh-tag-browser.log`,
qualification logs as `build/{version}-your-fresh-tag-check.log`, and native logs
as `build/{version}-your-fresh-tag-reference.log`. The finalizer takes the common
suffix `your-fresh-tag`; both edition folders and all four browser results must
exist before running it through the guard.

All four browser continuations passed. Joined evidence is recorded in
`build/mtmoon-v1-validation.json`: complete fresh-boot C histories for both
editions, two independent original-GBA save readbacks, and desktop/mobile
continuations with worker replacement and non-silent audio packets. Browser
checks start from the earlier qualified first-gym checkpoint; they do not repeat
that prefix. This qualifies the recorded Mt. Moon chapter, not the full game.

Later gyms, HMs, the rest of the main adventure, postgame, physical devices,
hosted account play and measured 1,000-player capacity remain separate work.
Public engine capabilities remain disabled. These checks do not change the
Netlify preview or deploy an account/game backend.
