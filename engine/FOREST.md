# Viridian Forest and Pewter adventure coverage

The original audio-16 cores have recorded input routes from the retained
starter/catch/PC adventure through Viridian City's catching tutorial, the
Teachy TV gift, Route 2, Viridian Forest and its Bug Catcher Sammy encounter,
then Pewter City's Pokémon Center and the original Save menu.

| Edition | Full replay frames | Bulbasaur after Pewter healing | Rattata |
| --- | ---: | --- | --- |
| FireRed | 107,633 | Level 8, 26/26 HP, Leech Seed learned | Level 3, 15/15 HP |
| LeafGreen | 119,547 | Level 7, 23/23 HP, Leech Seed learned | Level 3, 15/15 HP |

Every gameplay mutation comes from recorded button inputs. The exploration
helper reads map geometry to plan walking and chooses normal menu actions;
it never writes Pokémon, inventory, flags or positions. Wild encounters are
fled on the successful forest route, while trainer battles are fought. The
old man conducts the original catching demonstration. Both earned Pokémon
retain their personalities and trainer IDs, the bag's ball count is unchanged,
and all 14 storage boxes are preserved. The routes end outside Pewter's Center
at (17, 26), with controls unlocked and both Pokémon healed.

This extends gameplay coverage; it does not change the original C cores or
promote their capability flags. Brock and the first badge are explicitly
unqualified. Later gyms, HMs, full adventures/postgame, physical devices,
hosted accounts and 1,000-player operation remain open.

## Evidence and reproduction

`tests/replays/{firered,leafgreen}-forest-pewter-audio.json` contain the complete
movies from a fresh boot, including their earlier starter/catch/PC segments.
The immutable artifact IDs remain:

- FireRed: `firered-rev1-cd551d2c6a-5029b7861c85`
- LeafGreen: `leafgreen-rev1-cd551d2c6a-0cc0205a03d3`

`scripts/check-forest-adventure.ts` audits the retained checkpoint lineage,
replays the full movie without planning inspection calls, checks every segment's
canonical digest and unchanged immutable assets, and verifies original-menu
saving, fresh Continue, the original warm reset and complete checkpoint
restoration. Observation must preserve the digest. It also checks the actual
saved old-man scene variable, Teachy TV item, Sammy's trainer flag and forest
world-map flag. The first-badge flag must still be false.

The lineage reports and saves are retained in
`build/adventure-qualification/{firered,leafgreen}-forest-v1`. Earlier branches
that exhausted the party are retained outside the accepted lineage. LeafGreen's
accepted movie includes a recorded navigation detour in Pewter before it reaches
the nurse; the final assertions require actual healing and saving, regardless
of intermediate exploration labels.

Use a fresh evidence tag when repeating a qualification:

```sh
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/check-forest-adventure.ts firered forest-save-audio your-fresh-tag
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- python3 -B scripts/run-reference.py --version firered --save build/adventure-qualification/your-fresh-tag/adventure.sav --replay build/adventure-qualification/your-fresh-tag/continue-party.json --output build/reference/your-fresh-tag --dump-storage
node --experimental-strip-types scripts/check-forest-readback.ts firered your-fresh-tag
```

The readback checker requires the checksum-matching unchanged GBA baseline and
pinned mGBA reference. It compares the complete party and storage bytes after
original Continue, then decodes native bag quantities and progress flags from
the original game's RAM. This proves compatibility of these saved-game cases;
it does not establish full gameplay pixel or audio parity. The GBA reference is
test instrumentation and is never shipped in the browser.

Both unchanged original GBA games accept the retained Pewter saves. Their
party bytes, all 14 storage boxes, native key-item quantities, old-man scene
variable and forest/trainer flags match the corresponding C replay. The proof
does not award or qualify the first badge.

For browser verification, `scripts/prepare-forest-browser.ts` derives the entire
new continuation from the full movie. The starting PC checkpoint already has
full-replay desktop/mobile evidence with the same game-worker source and
artifact. `KANTO_ENGINE_CONTINUATION` adds a generic continuation option to the
existing worker test, preserving each new restoration milestone and checking
every emitted input batch against the private original-C replay. It checks
audio packet bounds and non-silent output, not physical speaker fidelity.

```sh
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/prepare-forest-browser.ts firered your-fresh-tag
KANTO_ENGINE_CANDIDATE=build/game-source/firered/audio-16 KANTO_ENGINE_CONTINUATION=build/adventure-qualification/your-fresh-tag/browser KANTO_ENGINE_AUDIO=1 KANTO_ENGINE_EVIDENCE_TAG=your-fresh-tag python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node node_modules/@playwright/test/cli.js test --config playwright.engine.config.ts --timeout=300000 --output test-output/your-fresh-tag
```

Replace the edition and use distinct tags for LeafGreen. The pure replay checks
run the full fresh-boot movie; the new browser checks resume the retained PC
checkpoint and run all 38,691 new FireRed or 50,485 new LeafGreen frames.
They use Chrome desktop/mobile emulation, not physical phones. Inspect retained
reports and logs for actual outcomes; a reproduction command is not proof of a
successful run. The public Netlify site remains a temporary solo preview.

The subsequent [first gym checks](BROCK.md) extend the recorded inputs through
training, Liam and Brock. They use separate candidates with repaired battle
text storage; old-artifact checkpoints are never loaded into those new cores.
