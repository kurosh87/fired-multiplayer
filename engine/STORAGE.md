# Original PC storage qualification

Both experimental 16 MiB candidates have input movies from a fresh game
through the earned starter, wild catch, Viridian's PC, deposit,
Save/reset/Continue, withdrawal and a second original-menu save. No game code
or public capability flags changed.

| Edition | Full route frames | Bulbasaur after withdrawal | Rattata after withdrawal |
| --- | ---: | --- | --- |
| FireRed | 68,942 | Level 6, 8/22 HP | Level 3, 15/15 HP |
| LeafGreen | 69,062 | Level 5, 19/19 HP | Level 3, 15/15 HP |

The pinned cores remain `firered-rev1-cd551d2c6a-32b55352a660` and
`leafgreen-rev1-cd551d2c6a-68ac436de4e8`.

Each route deposits its level-3 Rattata in Box 1, slot 1, leaving Bulbasaur in
the party. Its original cartridge save preserves that arrangement. Reset and
Continue recover it before the route reopens the PC and withdraws Rattata.
Each second save has two party Pokémon and empty boxes. Rattata returns at
15/15 HP through the original storage mechanics. Both Pokémon retain their
identity, experience and moves, and the verifier checks that neither is
duplicated or lost at each transfer/save milestone.

## Evidence and scope

- `tests/replays/{firered,leafgreen}-pc-storage-roundtrip.json` record every controller
  input. The verifier replays the complete catch prefix and every retained PC
  exploration segment from a fresh engine, comparing canonical digests.
- `build/adventure-qualification/{firered,leafgreen}-storage/report.json` record both
  saves, party and storage hashes, fresh-instance Continue, warm reset,
  complete checkpoint recovery and the exact candidate identity.
- Each unchanged, checksum-matching original GBA game accepts both of its saves.
  Its party-menu readback matches each occupied 100-byte party record. Its
  entire 33,744-byte PokémonStorage block matches, including all 14 boxes,
  current box, box names and wallpapers. Native occupied-slot flags agree
  with the recorded PC state, without bad-egg flags. This checks saved-game
  compatibility; it does not establish full gameplay/pixel parity.
- `build/record-abi-storage/report.json` checks 111 original ARM versus wasm32
  sizes/member offsets. The additional five checks cover PokémonStorage's
  size and all four fields, including the four-byte offset of its box records.
- Desktop and mobile Chrome emulation pass the complete movie in the actual
  game worker, with canonical replay parity and checkpoint replacement inside
  the PC and after each save. Both viewport proofs are retained in the
  qualification report. This does not establish physical-device coverage.
- `lobby-integration.json` in the qualification directory exercises the real
  server party inspector: the deposited save exposes only Bulbasaur; the
  withdrawn save exposes both Pokémon. Lobby save preparation preserves all
  boxes and leaves its source checkpoint untouched. Open PC screens are
  rejected; a recorded 726-frame return to field control then permits entry.
  These are local binding checks, not hosted accounts or a networked trade.

The original PC delays updating `gPlayerPartyCount` until its screen closes.
The trusted verifier inspects all six actual party slots during PC transfers
and checks the count again after returning to the field. Observation must
leave the canonical digest unchanged; every gameplay mutation comes from
recorded button inputs.

Repeated A inputs reopen the nearby PC after the second original Save finishes.
The lobby verifier proves that this snapshot is rejected, then replays the
retained `storage-field-return` inputs to close it before preparing a lobby save.
It does not relax the field-control checks. Earlier menu-selection exploration
branches and the first failing admission check remain retained as diagnostics,
outside the qualified movie's lineage.

## Reproduction

Build the pinned candidate and original GBA baseline first. Run finite jobs
through the project resource guard. Use fresh evidence/output names on repeat
runs to preserve existing results.

```sh
KANTO_ENGINE_CANDIDATE=build/game-source/leafgreen/memory-16 \
KANTO_ENGINE_REPLAY=tests/replays/leafgreen-pc-storage-roundtrip.json \
KANTO_ENGINE_EVIDENCE_TAG=pc-storage \
npm run test:engine-browser -- --timeout=180000 \
  --output test-output/engine-leafgreen-pc-storage

python3 -B scripts/run-reference.py --version leafgreen --dump-storage \
  --save build/adventure-qualification/leafgreen-storage/deposit.sav \
  --replay tests/replays/leafgreen-pc-deposit-continue-party.json \
  --output build/reference/leafgreen-storage-deposit
npm run engine:check-storage-readback -- leafgreen deposit
```

Repeat the reference commands with `withdraw` replacing `deposit` for the
second save. `npm run engine:check-storage` additionally audits the retained
exploration checkpoint lineage and both saves. That audit needs the local
`build/adventure-exploration/{firered,leafgreen}` evidence; the source input movie can
run independently once its candidate is built. The reference harness is test
instrumentation and is never served in the browser.

`node --experimental-strip-types scripts/check-storage-lobby.ts leafgreen`
checks the party/save bindings with these retained saves and the recorded
return-to-field branch. The adventure and lobby checks refuse to overwrite
their retained outputs. The readback checker augments the matching
qualification report after comparing the native result.

Replace `leafgreen` with `firered` in each path and argument to run the other
edition's checks. `npm run engine:finalize-storage -- firered` joins verified
native, browser, layout and lobby results and retains their source snapshots.
After finalization, `npm run engine:finalize-storage -- firered --check`
rechecks the evidence without changing it; the same command supports LeafGreen.
This command checks file identities and recorded results, and does not replace
running the actual game, original GBA reference or browser tests.

## Remaining work

Moving between boxes, item storage, box naming,
release/cancel paths, a full party and automatic capture overflow need their
own qualification. Further maps, gyms, HMs, postgame, audio, physical devices,
hosted accounts/saves and distributed 1,000-player operation remain open.
The public Netlify deployment remains a temporary solo preview.
