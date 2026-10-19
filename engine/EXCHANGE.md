# Original-game trade adapter

`port/kanto_exchange.c` and `packages/trading/original-core.ts` bind an isolated
instance of the actual FireRed/LeafGreen C game to a trusted server operation.
Public trading remains unavailable because candidate capabilities are still
unqualified. Authenticated invitation/offer handling, interactive trade
verification, durable scene recovery and the two-save commit are implemented
and can be checked against the isolated local database.

The C extension loads a canonical cartridge with the original save loader and
checks Pokemon through the original encrypted-data/checksum routines. Peer
packets contain original party, mail, link identity/progress and ribbon data.
They are copied only between server-owned cores; they are not client save uploads.
Each core represents itself as local player zero. Physical cable negotiation
is replaced at three checked callbacks, without reporting a fabricated RFU or
cable connection.

Party eligibility, last usable Pokemon checks, international Shedinja naming,
gift ribbons, trade animation, the party swap, mail transfer, friendship,
Pokedex updates, evolution restrictions, held-item consumption and move learning
remain original C. The complete original evolution/move-selection interface
continues to receive button inputs. A production service must obtain those
inputs from the player; the qualification tool's repeated A presses are a test
policy, not a production decision rule.

The fresh service instance calls the original scanline-effect initialization.
Normally the field loader does this before a cable-club trade. Omitting it lets
the move summary mistake task zero for an active wave task and discard the
evolution task. The extension also flushes the original deferred trade recap
event, normally flushed by the physical cable-club exit script, before saving.

Both resulting cartridges are staged. Neither is authoritative until the
server commits both saves and its receipt in one transaction and invalidates
the pre-trade sessions. A successful movie is not a successful database trade.

## Durable interactive service

`TradeOffers` binds each selection to the current server cartridge revision,
party slot and original 100-byte Pokemon digest. Both participants must review
and confirm the same offer revision; changing either selection clears both
confirmations. Egg species, level, HP and held item are redacted from public
offer metadata. Original C checks eligibility again before scenes start.

`TradeScenes` creates two original C instances with server entropy, exchanges
the original peer packets, and persists their packed starting checkpoints in
one transaction. Private `trade_scenes` and `trade_input_journal` rows stage
all progress separately from the adventure. Player buttons use the same frame
budget, fencing and durable-before-ack verification as adventures. A completed
C scene stores its resulting cartridge in the same transaction as its final
input acknowledgement. No client can submit a result cartridge.

Recovery restores a pinned checkpoint, normalizes stored JSON input batches,
and verifies every replayed frame/digest. A one-minute lease prevents another
process from concurrently owning a scene. An old fence cannot append or save
checkpoints. A completed scene can wait for the partner without a live lease.
Both staged cartridges must match the exact reserved adventures before the
repository changes either canonical save and writes one idempotent receipt.
Prior adventure sessions are superseded so they cannot restore old Pokemon.

Cancellation discards both staged results and returns both adventures to the
lobby. A bounded sweeper releases reservations after the ten-minute deadline;
neither canonical cartridge changes on cancellation or expiry. Reconnecting
does not extend that deadline. Production supplies only actual player inputs,
including the original evolution and move-learning decisions.

Run `KANTO_CHECK_ORIGINAL_TRADES=1 npm run db:check-local` after building the
current qualified early-game/exchange fixtures. It executes cross-version C
scenes through the actual database-backed service, restores journaled inputs
after a simulated process loss, verifies that one completed scene leaves both
adventures unchanged, and checks the final two-save commit. The move-learning
case starts from the pre-trade fixture cartridge and requires Politoed with
Perish Song after explicit test A-button inputs. The injected clock is a test
driver only. These fixtures prove mechanics/transport, not adventure provenance
or hosted account delivery. Reports retain the exact candidate identities.

With the local Vite service running at `127.0.0.1:5173`, add
`KANTO_CHECK_TRADE_UI=1` to that command for the complete local browser trade
journey. Fresh desktop and mobile-emulation Chrome contexts use the actual
Lobby, Game, game worker, HTTP/WebSocket authenticators and Postgres-backed
scene service. A test-only entry supplies an isolated auth-provider fixture;
no production auth setting or candidate capability is changed. Players invite,
select, confirm, play the original scenes, reload one browser mid-trade, and
observe both revisions change exactly once. Screenshots and
`build/trade-ui-report.json` retain the evidence. This is not physical-device
testing or proof of hosted signup/email confirmation.

## Experimental trade audio

Set `KANTO_CHECK_TRADE_AUDIO=1` alongside `KANTO_CHECK_ORIGINAL_TRADES=1`
and `KANTO_CHECK_TRADE_UI=1` to use the separate `audio-16` trade cores.
Use `KANTO_QUALIFICATION_MEMORY_MIB=16` to select their retained fixture
cartridges and a fresh `KANTO_UI_EVIDENCE_TAG` for each evidence run. Run
through the project resource guard. `KANTO_CHECK_AUDIO_LEGACY=1` is the
mutually exclusive check for disabled Sound on older cores.

Fixture checkpoints are decoded only by their original pinned artifact. Only
the resulting original-format cartridge crosses into the audio core; no
checkpoint or in-memory state is relabeled as belonging to another build.
The ordinary two-browser flow checks non-silent native Web Audio, pause/mute,
sound recovery after scene reload and context cleanup after commit. It pauses
the second player until the first finishes and checks that neither canonical
save changes while the first player's sound has stopped. Verified input
messages are captured and audio must stay out of that protocol. Both browser
entries load the same theme and shadcn controls as the application.

The API checks also run ordinary and move-learning scenes on the audio cores,
including worker loss, journal recovery, unchanged one-sided saves, atomic
completion and the original Politoed/Perish Song result. They use an explicit
test clock and button policy. Their local fixture Auth provider does not
establish hosted accounts, global transport, physical-device sound or earned
Pokémon provenance. Audio comparison against original GBA captures remains
open. Consolidated results and exact sources live in
`build/trade-audio-validation.json`.

## Journey with input-earned Pokémon

`KANTO_CHECK_EARNED_TRADE_JOURNEY=1` runs the separate
`tests/earned-trade-journey.ts` qualification. Set a fresh
`KANTO_UI_EVIDENCE_TAG` and use the project guard with
`scripts/check-database.py`. It restores the retained audio-core PC-route
checkpoints whose original-menu saves match the independently checked GBA
cartridges, then applies the recorded controller inputs that close the PC.
This trusted fixture setup runs only in the disposable rollback database.

From that point, two actual browser clients resume their adventures, enter
the lobby through the production save transition, offer their own caught
Rattata and play the original cross-version trade. Their distinct personalities
identify the exchanged Pokémon. Inspection checks each unchanged earned
starter, the received peer Pokémon, levels, HP, moves and recorded storage.
The trade retains the audio/pause/reload and one-sided-save checks.

After commit, the old sessions are superseded. The journey follows Back to
adventures and launches a new session from the committed cartridge; it must
not restore the pre-trade RAM checkpoint. Real controller inputs pass the
original Continue/recap screens, return to the field and save/exit. Read-only
inspection resolves the exact original overworld callback, including the
pinned Binaryen function-pointer adapter, and requires unlocked field controls.

`scripts/check-earned-trade-readback.ts <tag>` compares the resulting files
with independent original-GBA reference runs. Run `scripts/run-reference.py`
for each edition using its returned cartridge, the retained
`tests/replays/<edition>-pc-withdraw-continue-party.json` input movie, output
`build/reference/<tag>-<edition>` and `--dump-storage`. The comparison requires
the original Continue/party menu, exact earned party records and recorded
storage bytes. It preserves earlier reports and refuses to replace its proof.

This extends the local journey from existing earned checkpoints. It does not
claim a complete fresh-account network replay, hosted email/account coverage,
physical-device playback or every populated-box scenario. The original game
and public-release qualification gates remain unchanged.

## Cartridge record ABI

The matching agbcc Thumb compiler sets `STRUCTURE_SIZE_BOUNDARY` to 32 in
`gcc/thumb.h`; `gcc/stor-layout.c` applies that minimum alignment to unpacked
structures and unions. Clang's WASM ABI needs this expressed explicitly.
`prepare_records.py` annotates record definitions after preprocessing, including
nested and local records, while preserving explicitly packed records. Vendor
files remain unchanged. Both game compilation and the platform link use it.

This matters beyond the party: without the original record ABI, recap object
records were 18 instead of 20 bytes and mail entries 34 instead of 36, shifting
mail, ribbons and later save fields. A party-only readback did not cover these
fields. Old experimental snapshots and flash fixtures from that layout must
not be promoted or migrated as qualified player saves.

`npm run engine:test-record-layout` compiles the same layout fixture with the
pinned original ARM compiler and the prepared WASM compiler. The original trade
qualification compared 106 record sizes and member offsets, including every
direct non-bitfield member of both save blocks and the recap scene. The current
fixture adds five PC-storage size/member checks for 111 total. Candidate linking additionally checks
both save-block sizes and mail/ribbon offsets at compile time.

## Qualification tools

`engine:check-exchange -- build/game-source/firered` exercises ordinary trades,
mail/ribbons, Machoke evolution, Everstone, National Dex blocking/enabling,
Politoed's original move-learning prompt and eggs. Use the LeafGreen directory
for its matrix; supply both directories for cross-version trades. It also
checks last-mon/last-usable-mon rejection, malformed peers, source-save
immutability, unselected party bytes and fresh original-C save reloads.
The fixtures use distinct trainer IDs encoded by the original `SetTrainerId`
routine, and corrupt encrypted Pokemon checksums are rejected before a scene
can start.

These tools construct qualification-only Pokemon through original `CreateMon`,
`CreateEgg` and `SetMonData`; their output does not prove adventure provenance
and must never seed user inventories. Reports identify the exact artifacts and
input/output save hashes. Prepared checkpoints and recorded inputs support
browser-worker replay without adding any client-callable mutation API.

`engine:check-exchange-readback` loads each staged save into the unchanged,
checksum-matching original GBA game using pinned mGBA. It continues the game,
finishes the recap and opens the original Pokemon menu, then compares both
party records, mail, gift ribbons, the complete Pokedex structure and duplicated seen flags with the C/WASM
output. The independent emulator is a qualification tool and is never shipped
in the browser engine.

For a browser replay, set `KANTO_ENGINE_CANDIDATE` to the variant directory and
`KANTO_ENGINE_EXCHANGE` to an exchange-checks `learn-move-a` prefix, then run
`test:engine-browser`. The actual worker replays the original movie, restores
in a replacement worker during move selection, and must match the server's
state hashes and final exchange phase. Public capability flags remain false.

Local qualification on October 16, 2026 passed all three eight-case matrices
(FireRed, LeafGreen and FireRed/LeafGreen), all 48 independent original-GBA
save readbacks, and four desktop/mobile worker replays with recovery during
move selection. The artifacts were `firered-rev1-cd551d2c6a-8eefbb2b65b7` and
`leafgreen-rev1-cd551d2c6a-2e1a421718bb`. Reports and staged cartridges are
retained under `build/game-source/`; original-game readbacks are under
`build/reference/`. Global multiplayer service integration remains unfinished.

## Verified lobby handoff

`kanto_lobby_save` runs on a copy of the verified adventure at a frame boundary.
It requires an idle field, unlocked controls, no playback/battle/menu and a
Save option in the original start menu. The original menu setup decides this,
including Safari/Union Room restrictions. Replacing an existing adventure
requires confirmation through the original save dialog. It uses original map,
recap and cartridge save routines and preserves the post-save runtime too.

`Sessions.enterLobby` pauses/drains verified inputs, prepares that save, and
atomically stores the resulting runtime checkpoint and cartridge with a new
revision and session fence. A lost lease rejects the staged result. The old
game socket closes after commit. `leaveLobby` reacquires the post-save runtime;
it cannot restore the pre-save cartridge or mint another startup clock credit.
All adventure/session writers acquire locks in adventure-before-session order.

Authenticated routes provide entry, party inspection, presence and return to
the adventure. The browser waits for the durable WebSocket pause before entry,
and recovers a confirmed lobby if the HTTP response is lost. Polling presence
does not reload a WASM instance. Names are presentation text decoded from the
pinned English charmap; mechanics still use original C.

`engine:check-lobby` replays real gameplay before the first manual save in both
versions, rejects title/battle/menu entry, and verifies save/runtime recovery.
Separate guard fixtures cover restricted menus and pending overwrite consent.
`engine:check-lobby-readback` confirms original-GBA acceptance. Set
`KANTO_ENGINE_LOBBY=build/game-source/firered/lobby` with its candidate and run
`test:engine-browser` for actual worker recovery after the lobby save.

The Postgres contract also checks failed-lease rollback, entry retries, current
runtime recovery, presence expiry and suspended trainers. Its HTTP/WebSocket
test uses the real authenticator against an isolated get-user provider fixture;
it does not establish hosted Supabase account delivery or browser sign-in.
Trade scenes, preparation, eligibility and party inspection now execute in
bounded private worker pools. Their database commits and ownership checks stay
in the API; both canonical saves still commit together. Worker failure recovery
and the browser flow are locally qualified. See [WORKERS.md](WORKERS.md).
Public game artifacts remain disabled. Dedicated hosted account qualification,
full adventure coverage and distributed load qualification remain required.
