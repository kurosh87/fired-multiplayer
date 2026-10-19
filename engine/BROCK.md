# First gym verification

The first gym route continues the recorded [forest adventure](FOREST.md) with
ordinary wild training, learning Vine Whip, defeating Liam and Brock, receiving
the Boulder Badge and TM39, healing and saving through the original menu.
Every gameplay change comes from recorded button inputs. The exploration helper
never grants levels, items or flags.

The retained `firered-brock-v2` and `leafgreen-brock-v2` cases pass their complete
fresh-boot movies: 211,487 and 253,043 frames. Both movies also pass actual-worker
replay and worker replacement on desktop and mobile Chrome emulation. Each
unchanged original GBA game accepts its saved cartridge and matches all party
bytes, all 14 PC boxes, badge/TM flags and money. FireRed finishes with 4808 and
LeafGreen with 4728; Liam and Brock together award the original total of 1620.
The joined evidence is retained in `build/brock-v2-validation.json`.

## Battle text storage repair

Both pinned sources document a buffer overflow in Brock's defeat speech:
`data/maps/PewterCity_Gym/text.inc` and `src/battle_main.c`. The original
300-byte `gDisplayedStringBattle` spills into text scratch buffers and the
otherwise unused `sFlickerArray`. Clang removes that static unused array. In the
old WASM build, the speech therefore reaches live battle flags 352 bytes after
the display buffer. The retained replay reproduces the same overwrite in both
editions: the flags become `0xc6c000d9`, incorrectly setting the double-battle
bit and doubling Brock's prize.

`engine/port/prepare_battle_text.py` gives the display buffer 1024 bytes in both
its definition and declarations after preprocessing. The original dialogue
expansion scratch buffer is 1000 bytes; the battle wrapper appends control
bytes. No vendor source, dialogue, prize formula, battle mechanics or cartridge
record layout changes. The normal source and battle build pipelines apply the
same preparation. The isolated experiment recompiles all retained translation
units declaring the buffer and leaves earlier artifacts intact.

The experimental candidates live in
`build/game-source/{firered,leafgreen}/battle-text-audio-16`. Their manifests
retain disabled public capabilities. Enlarging this buffer relocates globals:
old-artifact checkpoints must never be restored into these new cores.

## Evidence and reproduction

`scripts/check-battle-text-overflow.ts` replays the old failing segment one
frame at a time. It records the precise flag transition and original expanded
dialogue bytes while asserting the retained final digest and immutable data.

`scripts/check-brock-adventure.ts` replays the entire recorded movie from a
fresh boot on the repaired core. It requires the earlier Pewter cartridge to
remain byte-identical, compares progress with the old checkpoints read-only,
and checks that Brock's full long dialogue retains every original byte and
control code while battle flags remain intact. Liam must award 220 and Brock
1400, for a combined increase of 1620. The check also requires exactly the
first badge, TM39, earned Vine Whip, the same two Pokémon, preserved PC storage,
healing, original Save, fresh Continue, warm reset and checkpoint recovery.

The following commands require the retained original exploration lineage and
existing native reference dependencies. Use fresh output tags. The isolated
build commands require a fresh candidate directory and refuse to overwrite it.

```sh
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- python3 -B scripts/link-candidate.py --version firered --audio-experiment --battle-text-experiment --memory-mib 16
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/check-battle-text-overflow.ts firered your-fresh-tag
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/check-brock-adventure.ts firered brock-save-audio your-fresh-tag
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- python3 -B scripts/run-reference.py --version firered --save build/adventure-qualification/your-fresh-tag/adventure.sav --replay build/adventure-qualification/your-fresh-tag/continue-party.json --output build/reference/your-fresh-tag --dump-storage
node --experimental-strip-types scripts/check-brock-readback.ts firered your-fresh-tag
```

The diagnostic proof used by the qualifier is retained under the fixed `v1`
diagnostic name. A new diagnostic tag preserves a separate reproduction; it
does not replace that pinned proof. Repeat for LeafGreen with its own tags.
The independent GBA check uses each unchanged, checksum-matching original
cartridge and compares all party bytes, all 14 storage boxes and native
badge/TM/money data after Continue. This checks save compatibility, not full
gameplay pixel or audio parity. The reference emulator is never shipped.

Browser verification can run the complete new movie using
`KANTO_ENGINE_CANDIDATE=build/game-source/firered/battle-text-audio-16`,
`KANTO_ENGINE_REPLAY=build/adventure-qualification/your-fresh-tag/replay.json`,
`KANTO_ENGINE_AUDIO=1` and a fresh `KANTO_ENGINE_EVIDENCE_TAG` with the existing
`playwright.engine.config.ts`. Each worker input batch must match the private
C replay; milestones replace the actual browser worker from checkpoints.
Desktop and mobile Chrome emulation remain distinct cases. A successful
qualification requires inspecting the resulting reports, not just running a
command or building a candidate.

The first gym is one milestone. Later gyms, HMs, the rest of the adventure,
postgame, physical devices, hosted accounts and distributed 1000-player
qualification remain open. These checks do not promote production artifacts
or deploy a new public preview.

The subsequent [Route 3 and Mt. Moon checks](MTMOON.md) cover running shoes,
natural Ivysaur evolution, Team Rocket, the fossil choice and a saved arrival
in Cerulean City in both editions. They retain separate native/browser evidence.
