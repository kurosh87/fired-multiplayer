# Cerulean Gym verification

The recorded chapter starts from the fully qualified same-artifact
[Mt. Moon adventure](MTMOON.md). Both editions defeat Luis, Diana and Misty,
receive the Cascade Badge and one TM03, heal through the original nurse,
and save in Cerulean City. All game changes come from recorded controller
input in the unchanged original C core. The earlier Boulder Badge, TM39,
running shoes, Dome Fossil, Pokémon identities and all PC storage are preserved.

| Edition | Frames after Mt. Moon | Final frame | Money | Ivysaur |
| --- | ---: | ---: | ---: | --- |
| FireRed | 32,445 | 374,568 | 9408 | Level 21, 61/61 HP |
| LeafGreen | 31,137 | 415,045 | 8912 | Level 21, 57/57 HP |

Both routes use free healing before Misty and after the battle. The caught
Rattata remains level 3 with its original experience. The original trainer
records independently account for the exact 2544 increase in money: Luis 64,
Diana 380 and Misty 2100. The prize reader now accepts the original no-held-item
custom-move party format used by Misty, as well as default-move parties.
It still rejects held-item formats and doubles rather than assuming a formula.

Misty's original field script marks all gym trainers defeated. The verification
therefore requires independent pre-Misty Luis and Diana wins and their exact
money changes. Checking only the final gym flags would not prove those battles.

## Checks and evidence

`scripts/check-misty-adventure.ts` binds the exact Mt. Moon checkpoint to its
joined qualification report, checks the earlier frame/digest/cartridge and
selected state, and independently replays every new input segment. It requires
every segment digest to match and refuses failed exploration branches.
The earlier full fresh-boot history is supplied by the linked Mt. Moon proof;
this case does not replay that prefix. Its report explicitly records
`pureInputContinuation: true` and `freshBootFullMovieReplayedThisCase: false`.
A complete combined input movie is exported for later fresh-boot replay.

The check also exercises original-menu Save, a fresh original Continue,
warm reset and Continue, and complete WASM checkpoint restoration. Both final
parties must be healed with no status conditions, and immutable assets must
remain unchanged. The initial checkpoint is the only state restored during
the new chapter replay; exploration checkpoints never supply its later state.

`scripts/check-misty-readback.ts` loads each exact cartridge into the
checksum-matching original GBA release with the pinned native reference.
It compares all party bytes and all 14 PC boxes, checks for Bad Eggs and
extra party members, and independently reads the badges, gym flags, TM03,
earlier items, money, evolution/healing/trade counters and saved position.
This establishes save compatibility for the recorded journey, not full
original-GBA gameplay pixel or audio parity.

Browser qualification uses `playwright.engine.config.ts` with the chapter's
`browser` continuation fixture and audio enabled. Every new input runs in the
actual worker and must match a separate C replay. Each segment milestone
replaces the worker from a checkpoint. Desktop and mobile Chrome emulation
are separate cases; neither repeats the previously qualified Mt. Moon prefix.
All four browser cases and both independent original-GBA readbacks passed.
The joined evidence is recorded in `build/misty-v1-validation.json`, with exact
executed sources in `build/misty-v1-source`. This qualifies the recorded second
gym continuation and its save compatibility, rather than the complete game.

For a fresh output tag, run finite jobs through the project guard:

```sh
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/check-misty-adventure.ts firered misty-save-v1 firered-your-fresh-tag
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/check-misty-readback.ts firered firered-your-fresh-tag
```

Repeat with LeafGreen. Keep qualification, native and browser logs as
`build/{version}-your-fresh-tag-{check,reference,browser}.log`.
After inspecting all four browser cases, run
`scripts/finalize-misty-evidence.ts your-fresh-tag` through the same guard.
It joins both saves, all four worker proofs, the transitive prefix and exact
executed sources; it preserves the original pre-join save reports.

The accepted lineage has five segments per edition. A preliminary FireRed
exit plan stopped on the gym's door tile before leaving; its failed report,
actual input, checkpoint and image remain retained outside the accepted route.
The corrected plan holds the original Down control long enough to exit.
No game movement or collision code was changed.

Later gyms, HMs, the remaining adventure and postgame, physical devices,
hosted account play, Linux deployment and measured 1,000-player capacity
remain unfinished. All public engine capabilities remain disabled.
This work does not change the public solo Netlify preview.
