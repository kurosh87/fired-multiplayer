# Kanto Online

FireRed and LeafGreen in the browser, with accounts, verified progress, global battles, and trading.

**Current state: the experimental browser player with accounts and solo cloud saves is live at [kanto-online-preview.netlify.app](https://kanto-online-preview.netlify.app).** It runs the source-built FireRed and LeafGreen candidates with keyboard/touch controls, sound, a controls guide, an FPS overlay and restart confirmation. Open Account to sign up, confirm your email and reserve your permanent trainer name. Use SAVE in the original game menu, then Account → Sync current game save. Each account can keep three independent adventures per edition; existing saves are preserved in the first slot. Unsynced progress stays in the open tab. Global battles and trades still need hosted game execution. The current execution order and launch gates are tracked in [ROADMAP.md](ROADMAP.md) and the GitHub issues.

The [temporary Netlify account setup](infra/NETLIFY-ACCOUNTS.md) follows Design Hub's Better Auth/Postgres pattern with a separate Kanto database and login secret. Production deploy `6ad3a4e3ce306ae83fa3e14d` passed hosted API checks; four hosted desktop/mobile player checks passed on the same bundle before publish. The account form now stays mounted during background anonymous-session refreshes, preserving typed credentials. Native Postgres and browser checks cover signup, confirmation, recovery, unique names, owner isolation, concurrent saves, slot creation races, legacy-save migration and actual WASM flash load/export for both editions. Live email delivery has not been exercised by the automated checks. Release evidence: `build/netlify-accounts-release-1792255070/report.json`; `published.json` verifies the public HTML matches the validated bundle.

The player caches hash-verified game downloads and skips unused solo verification journals. The separate main application now downloads play screens on demand; a controlled production comparison reduces initial JavaScript by 18.5%, with desktop/mobile download-failure recovery checks. This is a bundle-size improvement, not a device-FPS claim. Actual C-worker comparison preserves identical frames, pixels and flash across both modes; these local samples do not establish physical-device FPS. The [platform direction](PLATFORM-DIRECTION.md) records HGSS GitHub research, the proposed original-151 cross-generation format, one-way transfer compatibility, a shared Pokédex and weekly community scoring. DS gameplay, cross-generation conversion and public leaderboards remain future work. A separate local multiplayer regression now blocks game inputs during forfeit confirmation and finishes an original-C match with reconnect and unchanged adventure saves.

The separate application implements accounts, verified saves, battle challenges and reviewed trades. Its main account and battle journey now passes locally with actual Better Auth accounts and restricted Postgres credentials. Trade qualification still uses the earlier isolated fixtures. Its shared shadcn UI covers account forms, adventure selection, the lobby, player tools and battle screens. Integrating hosted accounts with global multiplayer remains unfinished. The candidates are not qualified for complete adventures or installed in the application's public artifact registry.

The persistent API and gateway now have a [Better Auth adapter](infra/BETTER-AUTH-MULTIPLAYER.md). Actual SDK-created accounts complete the local original-C desktop/mobile battle journey, including logout revocation and fresh-login recovery. Adventure/trade bootstraps carry the selected adventure UUID, and native database checks reject ambiguous or foreign selections without changing another save. All six account, adventure and private game migrations are applied in production. The main browser account adapter passes desktop/mobile account, independent-adventure and battle navigation checks. A [request-driven execution experiment](infra/NETLIFY-GAME-EXECUTION.md) preserves an entire original-C battle across 168 fresh workers. Hosted game execution and an explicit policy for admitting existing solo progress remain unfinished; the live entry point is still the solo player.

A [bounded HTTP battle transport](infra/REQUEST-BATTLE-API.md) also completes a full original-C match with actual accounts and restricted PostgreSQL. It preserves clock credit across requests, acknowledges only after an atomic receipt, recovers lost replies and worker failures, and prevents a peer from stalling play by withholding controls. Its themed browser viewer passes desktop/mobile checks on PostgreSQL 18. The [Netlify battle Function](infra/NETLIFY-BATTLE-FUNCTION.md) now passes an actual hosted preview journey with authenticated accounts, original C, checkpoint/picture parity, reply replay, tab replacement and forfeit. Its initial advancing latency is too high for public play. Idle worker reuse passes the full local regression, but its preview build failed; no hosted speed improvement is claimed. The public player remains solo.

An authenticated [routing gateway](infra/GATEWAY.md) now keeps adventures and
trade scenes on their account's assigned API, while both battle players reach
the same battle service. A local check runs two API OS processes and private
process workers with the original C cores and PostgreSQL. Both adventures
recover after a gateway restart; trainers see each other across nodes; an
original battle delivers both personal screens before a checked forfeit; and
both original trade scenes finish across nodes with one atomic save exchange.
The repaired first-gym saves also pass this exchange with their badge, TM39,
money, starter and PC storage intact; the original GBA games independently read
back both committed saves and count one trade each. Scene retirement waits for
checkpoint persistence, including disconnect/reopen and shutdown races.
Topology is fixed. Cross-machine deployment, automatic failover, global
admission and 1,000-player load qualification remain unfinished.

Recorded original-C/browser journeys cover starters, first rival results, catching, original-menu saves, Continue/reset, and PC deposit/withdrawal. FireRed's early route wins; LeafGreen's covers the rival-loss branch. Browser-worker state matches headless replay, including replacement-worker recovery. A locally qualified journey trades the input-earned Pokémon and returns to both adventures; the unchanged original GBA releases accept those resulting saves. These checks do not establish every gym, HM, late-game event or physical-device behavior.

The subsequent [Route 3 and Mt. Moon journey](engine/MTMOON.md) reaches Cerulean
in both editions with running shoes, an input-earned Ivysaur and the Dome Fossil.
Complete fresh-boot C histories, original GBA Save/Continue readbacks and four
desktop/mobile browser continuations preserve the first badge, TM39, earned
money, party identity and PC storage. This extends local verification; the rest of the adventure remains unfinished.

The recorded [Cerulean Gym continuation](engine/MISTY.md) also defeats Misty
in both editions, earns the Cascade Badge and TM03, and saves a healed level-21
Ivysaur party. Its qualification composes the exact earlier Mt. Moon checkpoint
and replays every new input; the earlier fresh-boot prefix remains a separate
linked proof. Both original-GBA save readbacks and all four desktop/mobile
browser continuations pass; joined evidence is in `build/misty-v1-validation.json`.

## What is implemented

- Responsive React application with adventure selection, account creation/sign-in, email confirmation, password recovery, trainer onboarding, and a browser game host with keyboard, touch and gamepad input.
- Supabase account integration and ordered migrations plus a declarative Postgres schema for immutable unique handles, one adventure slot per version, sessions, durable input journals, battles, and trades.
- A shared WASM ABI, integrity-checked artifact registry, strict platform-import validation, checkpoint restoration, and frame input validation.
- Server verification that sequences input, rejects accelerated/replayed/conflicting mutations, and acknowledges frames only after a durable journal append.
- Session ownership, fencing, artifact-specific packed checkpoints, journal recovery, and prototype WebSocket transport. Packed checkpoints reconstruct every memory byte and retain compatibility with earlier private full-memory checkpoints.
- Adventure, trade and battle sockets support same-account authentication renewal while preserving game state and input sequencing. The server periodically rechecks confirmed-email identity and suspension; failed renewal closes the connection for verified recovery.
- Battle orchestration and atomic trade coordination behind trusted-game interfaces. The original C trade scene has an experimental adapter and an eight-case matrix for both games and cross-version trades. Authenticated offers, confirmations, staged input journals and two-save commit integration are implemented. See [trade implementation and qualification](engine/EXCHANGE.md).
- An experimental original-C link-battle core runs both consoles, including cross-version matches, earned levels, damage, fainting and forced switches. Recorded inputs replay deterministically; adventure cartridges stay unchanged. A browser screen codec keeps private core memory out of viewer downloads. Authenticated challenges, acceptance, private server consoles, durable button journals, server deadlines, reconnect, forfeits and interactive browser controls are implemented for local qualification; see [battle implementation and qualification](engine/BATTLES.md).
- A Postgres trading repository that commits both saves and its receipt together and supersedes old sessions to prevent restoring pre-trade inventories.
- Verified lobby entry saves current progress through original C, commits the cartridge and runtime checkpoint together, and fences the prior connection. Lobby exit restores that post-save runtime. Presence, party screens and reviewed trade invitations use authenticated endpoints. The trainer directory supports case-insensitive name-prefix search and pages of 50 trainers, so names beyond the first 100 can be found. Trade scenes run separately from paused adventures until both players finish.
- Quick Match queues a lobby trainer with one click and pairs the closest waiting party — snapshot levels within ±15, widening to any waiting trainer after a minute — through the same authenticated challenge and acceptance as a directory challenge, with a single conditional claim, restored entries on a failed start and a ten-second sweep for entries both requests missed. The directory now shows a bounded party snapshot (species and earned levels captured at lobby entry) with edition and level-band filters, plus a live stream: committed join, departure, battle and trade transitions notify a dedicated Postgres listener, and the authenticated read-only `/api/lobby-play` socket pushes self-excluded `sync`/`put`/`del` events that the page merges under its active filters while the 20-second poll stays the authority for paging. An authenticated `/api/battles/live` projection lists active battles, the lobby presence socket pushes list replacements as battles start and finish (the five-second poll remains the fallback), and a read-only spectator socket (`watch:{side:'a'|'b'}`) fans the same encoded pixels out to at most ten watchers per battle without exposing inputs, saves or journals. Contracts live in `tests/quick-match-postgres.ts`, `tests/quick-match-http.ts`, `tests/lobby-discovery.ts`, `tests/lobby-presence.test.ts`, `tests/lobby-presence-api.test.ts`, `tests/lobby-directory.test.ts`, `tests/battle-watch.test.ts`, `tests/battle-watch-api.test.ts` and `tests/lobby-presence-journey.ts`, with the Quick Match card, the live merge and the watch screen covered in the browser specs; the native local run (typecheck, unit suite, disposable-database contracts, browser specs and production build) passes under Node 24, the hosted migration is applied on the private battle preview only, and no public capability is enabled. See [quick match and lobby presence](infra/QUICK-MATCH.md).
- Verified exit mirrors the game's cartridge flash into the adventure record in the same transaction that closes its session. Exit blocks concurrent input/resume; erased cartridges remain null saves. Trade inputs retain each adventure's game version for the original-game adapters.
- Pinned upstream source references, guarded source bootstrap/preparation, a frame-stepped main loop, mapped hardware memory, input encoding and a portable DMA controller, port audit, replay verification and smoke benchmark tools.

The current API coordinates local adventure, battle, trade and inspection pools, using threads by default or separate child processes when configured. It is **not** the distributed 1,000-player deployment. Checkpoints currently use Postgres; private object storage, host/container resource and permission limits, and cross-machine routing are still needed before load qualification.

Adventure disconnects now checkpoint and release their worker slot with a new
writer fence. Shared WebSocket heartbeats detect unresponsive connections.
See [connection cleanup and its qualification](infra/CONNECTION-LIFECYCLE.md).

## Local checks

Node 24 or newer is recommended. The lightweight runtime tests also work on Node 22.11 with type stripping.

```sh
node --experimental-strip-types --test tests/*.test.ts
python3 -B -m unittest discover -s tests -p '*_test.py' -v
node scripts/preflight.mjs
```

The fixture WASM in the tests is a small arithmetic module used to exercise runtime/verification contracts. It is never presented as Pokémon and is not shipped in the web app. Unit tests do not establish game compatibility.

`preflight` returns a nonzero status until both actual game artifacts exist. It reports configuration presence only, never secret values.

## Install and launch the application shell

On this Mac, `/Users/pejman/AGENTS.md` requires the shared `~/.local/bin/mini-build-guard` lease for heavy builds, tests, and installs. Use the task-specific startup override below when needed. Colima is intentionally held off.

```sh
node scripts/install.mjs
cp .env.example .env
# Fill in the new project's Supabase settings; never reuse unrelated project credentials.
npm run dev
```

Dependencies are installed and `package-lock.json` is retained. CI uses `npm ci --ignore-scripts`. Development serves the frontend at `http://127.0.0.1:5173` and API at `http://127.0.0.1:8787`.

The application passes the full TypeScript check, production Vite build, and desktop/mobile browser smoke checks. Without account configuration, the UI explains that sign-in is unavailable. Without engine artifacts, play remains disabled.

The user explicitly authorized continuing despite storage issues on October 16. For this task, use `python3 -B scripts/run-local.py --allow-low-disk -- COMMAND ...`. This overrides the startup disk reserve while retaining the shared lease, memory/swap monitoring, growth limit and emergency stop. For the remaining low-write preview/build checks, `--allow-low-disk --min-free-gib 2` applies the user's override to the task's running disk reserve as well; these checks are expected to write less than 50 MiB. Neither option changes global policy or removes retained files.

## Accounts and database

The temporary hosted application uses the dedicated Netlify Postgres database and Better Auth described above. The following Supabase instructions describe the older optional prototype configuration. They do not apply to the live site.

Create a dedicated Supabase project; configure email confirmation, password reset redirects, and production SMTP. The browser receives only the publishable key. The server requires its own database connection through the transaction pooler and authenticates access tokens with Supabase Auth.

Schema sources are `supabase/schemas/001_kanto.sql` and `002_api_runtime_role.sql`, declared in `supabase/config.toml`. The two reviewed migrations have been applied through the actual CLI to fresh native test databases, with matching declarative schema dumps and restricted-login checks. No hosted Supabase migration has been applied. The separate three Netlify migrations are applied in production. See [staging setup](infra/STAGING.md), [runtime permissions](infra/RUNTIME-ROLE.md), and the [itemized hosting quote](infra/HOSTING-QUOTE.md).

The optional Postgres integration test requires `pg` to be installed and an explicitly supplied `DATABASE_TEST_URL` for an empty disposable database with role/schema creation privileges. It refuses an existing `public.profiles` table and rolls back all of its changes. It is skipped when that URL is absent.

```sh
node --experimental-strip-types --test tests/postgres.integration.test.ts
```

`npm run db:check-local` starts a project-owned Postgres 17 test cluster on a private Unix socket, runs the database contract, and stops that server. This check passes locally for profile ownership, case-insensitive handle uniqueness, private-table restrictions, atomic/idempotent trades, invalidation of pre-trade sessions, packed checkpoint recovery followed by journal replay, legacy checkpoint recovery, and rejection of writes from a superseded session. It uses no Colima or hosted project. The small test cluster is retained under ignored `build/postgres-test/`.

`npm run test:web` starts or reuses the local development servers and runs desktop/mobile checks. On this Mac it launches a fresh headless Chrome session; screenshots are under ignored `test-output/screenshots/`. These checks cover the application shell and account forms, not successful hosted sign-in or gameplay.

## Try the local game engines

Once the candidates below have been built:

```sh
npm run engine:preview
```

Open `http://127.0.0.1:5174/engine-preview.html`, choose FireRed or LeafGreen, and start. This serves the actual compiled game in the same browser worker, with keyboard and touch controls and pause/resume. It binds only to localhost and leaves the application's public artifact registry unchanged. Restart the preview server after rebuilding a candidate.

This development preview has no account, durable journal or multiplayer connection. Its original-menu saves live only in the current worker and disappear on reload/restart. The separate application implements verified account progress. `npm run test:engine-preview` exercises the preview entry point in desktop/mobile Chrome; the longer engine replay tests additionally check server parity and replacement-worker recovery.

## Build the real game port

The source bootstrap downloads the exact commit in `engine/upstream.lock.json` into ignored `vendor/pokefirered`. It does not modify upstream sources or accept ROM uploads.

```sh
python3 scripts/fetch-upstream.py
python3 scripts/prepare-engine.py
python3 scripts/audit-port.py
```

The experimental compilation lane uses the separately pinned native FireRed reference for its portable C BIOS, graphics and sound. It compiles 290 C units and converts 361 original script/music data files, preserving relocations and function-table references. The final frame scheduler uses Binaryen Asyncify inside WASM; nested frame waits, the live game stack and recovery state stay in linear memory, with no host imports. Original vendor sources remain untouched.

Required tools are GNU Make, a Clang with the wasm32 code-generation backend, ARM GNU binutils, wasm-ld and Binaryen. Apple's system Clang cannot emit the WASM object code; on this Mac the scripts use Homebrew LLVM.

```sh
python3 -B scripts/fetch-upstream.py --reference nativeFireRedReference
python3 -B scripts/compile-game.py --version firered
python3 -B scripts/build-game-data.py --version firered
python3 -B scripts/link-candidate.py --version firered
node --experimental-strip-types scripts/check-candidate.ts build/game-source/firered
npm run test:engine-browser
```

Candidates and qualification reports stay under ignored `build/game-source/`, separate from application artifacts. Use `--version leafgreen` for its distinct compilation/data lane. `KANTO_ENGINE_CANDIDATE=build/game-source/leafgreen npm run test:engine-browser` selects that candidate. Core checks include compiled C hardware/DMA/libc tests, a real ARM-data relocation round trip, ARM-compatible callback casts and nested coroutine/checkpoint execution. Browser tests exercise the actual game worker on desktop/mobile and retain screenshots. Self-replay parity does not establish independent GBA correctness. Intro/title animation timing, timer/reset/device behavior, flash fidelity and later gameplay still need qualification.

The independent GBA baseline lane builds the unchanged original source with pinned agbcc. Both revision-1 ROMs match their upstream SHA-1 checksums. A pinned headless mGBA library runs recorded button inputs for comparison; it is never part of the browser engine. The first FireRed comparison found exact RGB555 matches for Oak's dialogue and the bedroom; animated intro/title captures differ and are being investigated. Both unchanged GBA releases also accept their WASM-generated saves, finish the recap, and open the original Pokemon menu with the correct level/HP and no bad-egg/checksum error.

```sh
python3 -B scripts/fetch-upstream.py --reference agbccReference
python3 -B scripts/build-baseline.py --version firered
python3 -B scripts/fetch-upstream.py --reference mgbaReference
python3 -B scripts/run-reference.py --version firered
node --experimental-strip-types scripts/compare-reference.ts firered
```

`npm run engine:check-gameplay -- build/game-source/firered` executes the full recorded early-game route, checks the original save and fresh-instance Continue, then checks the original reset chord and saved-game recovery. Use `build/game-source/leafgreen` for its separate fixture. To verify a generated save independently:

```sh
python3 -B scripts/run-reference.py --version firered --replay tests/replays/continue-party.json --save build/game-source/firered/gameplay.sav --output build/reference/firered-save-readback
npm run engine:check-save-readback -- firered
```

`KANTO_ENGINE_REPLAY=tests/replays/starter-rival-save.json npm run test:engine-browser` exercises the longer FireRed route in the actual browser worker. For LeafGreen, select both `KANTO_ENGINE_CANDIDATE=build/game-source/leafgreen` and `KANTO_ENGINE_REPLAY=tests/replays/leafgreen-starter-rival-save.json`. These tests use desktop/mobile viewports in fresh headless Chrome sessions; they do not establish physical iOS/Android coverage.

The title-screen entropy counter now derives its initial phase from the trusted 32-bit server seed and advances with simulated frames. `npm run engine:check-entropy -- build/game-source/firered` checks that upper seed bits and title input timing affect the original trainer-ID seeding, while checkpoint replay and reset preserve determinism. It is not general cycle-exact timer emulation.

Next engine work:

1. Extend independent original-game comparisons beyond the checksum-matching FireRed/LeafGreen revision-1 baselines.
2. Complete remaining timer, flash and physical-device behavior and extend reset qualification; retain applicable notices for reused reference code.
3. Resolve animation timing differences and check graphics and gameplay against the original-game baselines.
4. Produce real `engine/artifacts/firered.wasm` and `leafgreen.wasm`, plus manifests documented in `engine/README.md`.
5. Extend the early-game, battle, save/reset and checkpoint checks across both versions and later adventures.

Battles now run in a bounded local worker pool with checkpoint recovery after worker failure. Set `BATTLE_WORKERS` for its per-process limit. `npm run engine:check-battle-workers` compares it against the original C replay; `npm run engine:benchmark-battles` measures the retained thread-mode workload and compressed screen transport. See [battle details](engine/BATTLES.md) and [measurements and limits](engine/PERFORMANCE.md).

Adventure verification, state hashing, compressed checkpoints and original lobby-save preparation also run in bounded workers. Set `ADVENTURE_WORKERS` for their per-process limit. `KANTO_CHECK_ADVENTURE_WORKERS=1 npm run db:check-local` checks both recorded original-game routes, a worker crash before acknowledgement, checkpoint/journal recovery, clock-credit restrictions and atomic lobby saves. See [worker implementation and evidence](engine/WORKERS.md).

`GAME_WORKER_TRANSPORT=process` now runs adventure, battle, trade and inspection workers in separate child address spaces, with a supervisor that stays responsive during game execution. Crash/parent-loss recovery, private buffer ownership, both original adventures, the original battle and the earned-Pokémon browser trade journey pass locally. Both unchanged GBA games accept that journey's resulting saves. Threads remain the local default. Host/container RSS limits, permission isolation, distributed routing and process-mode capacity/cost measurements remain required; previous thread benchmarks are not process-mode sizing.

Separate [16 MiB adventure/trade candidates](engine/MEMORY.md) now match the retained 64 MiB cores' serialized state and pixels throughout both recorded adventures and produce the same original-format saves. Desktop/mobile worker parity, original-GBA save readback, trade matrices and database recovery checks pass. A paired local mixed workload observed 34% lower process peak RSS. Set `KANTO_QUALIFICATION_MEMORY_MIB=16` for the private qualification provider or temporary preview; the retained default candidates and public capability flags remain unchanged.

The [extended adventure checks](engine/ADVENTURE.md) record 56,843 FireRed frames and 56,383 LeafGreen frames through Route 1, the parcel/Pokédex quest, a wild capture and original-menu save. LeafGreen also verifies Pokémon Center healing. Fresh Continue/reset recover both Pokémon and inventory; each unchanged GBA game accepts its save and matches both party records. Both complete routes pass actual-worker replay and restoration on desktop and mobile Chrome emulation. Full-game and hosted-service qualification remain open.

The [PC-storage checks](engine/STORAGE.md) extend FireRed to 68,942 frames and LeafGreen to 69,062 through deposit, Save/reset/Continue, withdrawal and another original-menu save. Both saves for each edition match its original GBA game's party and complete 14-box storage block. Desktop/mobile workers pass both full replays and checkpoint recovery. Local lobby bindings expose only the current party, preserve boxes and reject entry while PC menus are open. Other PC operations still need qualification.

The experimental [browser audio preview](engine/AUDIO.md) now plays both C mixers through the shadcn Sound control, muted by default. Separate audio builds align synthesis and playback with the original frame timing while retaining the earlier candidates. Desktop/mobile full-route worker replays, checkpoint recovery and real Web Audio output checks pass; HTTPS preview checks also cover touch, pause, mute, the original reset chord and restart. The authenticated Game screen shares these controls and dark theme tokens; local real-verifier/PostgreSQL checks cover sound, lobby save/return, exit and disconnect recovery in both editions. Hosted account deployment, battle audio, physical devices and original-GBA sound fidelity remain unfinished.

Trade scenes, trade eligibility and lobby-party inspection also run in private workers. `TRADE_WORKERS` and `INSPECTION_WORKERS` bound their separate pools. The real C/Postgres checks cover an in-flight trade-worker crash, journal recovery without extra clock credit, the original evolution/move-learning menus and two-save atomic completion.

Experimental audio trade cores now pass the ordinary two-browser trade with native Web Audio, pause/mute, scene reload and sound cleanup. One completed scene stops sound while both canonical saves remain unchanged until the partner finishes. The same cores pass the API evolution/move-learning and worker-recovery cases. These fixture cases check mechanics with a local Auth provider. Physical-device playback, original-GBA sound fidelity and hosted accounts remain unfinished. See [trade details](engine/EXCHANGE.md).

The separate earned-Pokémon journey resumes both retained PC-route checkpoints, enters the lobby through the actual save transition, trades the caught Rattata and returns through original Continue to an unlocked field. Each original starter, the peer's distinct caught Pokémon, earned levels and recorded storage survive. Both unchanged GBA games accept the resulting cartridges through Continue and the party menu, with exact party and recorded storage bytes. This is a continuation from previously input-earned checkpoints, not a complete fresh-account network replay. Quick keyboard/touch taps now latch until the next game tick so presses released between animation frames are not lost; pause and exit clear pending input.

The authenticated player also has a branded shadcn toolbar with Controls, Stats and supported-browser fullscreen. Its overlay measures canvas FPS, average update interval and simulation speed. The controls guide pauses audio and durable play, blocks gameplay keys while open and leaves the game paused after closing. Both editions pass desktop/mobile checks against the local verifier and PostgreSQL; desktop checks also cover the guide in fullscreen. See [UI conventions](apps/web/src/components/README.md). These account-screen refinements are local; the public solo preview remains a separate deployment.

Live battles are opt-in: a directory challenge can allow spectators, quick matches always start private, and the live list requires an unsuspended account with a live lobby session. Only opted-in active battles appear, and a direct watch attempt on a private battle is rejected.

`GET /api/lobby/trainers?search=Scout&after=scout049` searches live waiting trainers after an optional canonical-handle cursor. Responses include `trainers` and `nextCursor` (or `null` on the final page). Names and cursors contain no private game data. Search treats underscores literally, and the directory excludes the caller, expired presence, suspended accounts and trainers currently playing a battle/trade. Pagination follows immutable, case-insensitively unique handles rather than offsets; live arrivals and departures can change a page, so it is not a snapshot of all online accounts. The UI provides next/previous pages, refresh and search, and discards stale responses. A read-only authenticated `/api/lobby-play` WebSocket streams self-excluded `sync`/`put`/`del` events derived from committed Postgres notifications; the poll remains the authority for paging and the stream is additive. The default Postgres contract checks 132 visible trainers; `npm run test:web` exercises the actual lobby UI with 150 synthetic trainers on desktop and mobile. These checks do not qualify hosted accounts or 1,000 concurrent players.

Next qualify the account/adventure/battle/trading journey against a dedicated hosted account service and expand original-game coverage. Full adventure/postgame coverage, physical mobile-device QA, cross-machine routing, host/container resource and permission limits, mixed load testing and a costed deployment remain required before public launch. `PUBLIC_RELEASE=true` refuses startup in this prototype.

The [Netlify browser preview](infra/NETLIFY-PREVIEW.md) packages both experimental game versions for solo play without the SSH machine's local server. The [Netlify account service](infra/NETLIFY-ACCOUNTS.md) adds temporary hosted login and cloud saves. Multiplayer remains separate and still needs a persistent host.

The latest [forest adventure coverage](engine/FOREST.md) continues both original
audio cores through Viridian's catching tutorial, Teachy TV, Route 2 and the
required forest trainer to Pewter City's healing and Save menu. The complete
input movies cover 107,633 FireRed and 119,547 LeafGreen frames. Both retain
their earned Pokémon, party identity and all 14 PC boxes, with fresh Continue
and warm-reset recovery. That route ends before the first gym.

The newer [first-gym coverage](engine/BROCK.md) verifies earned training, Liam and
Brock victories, the Boulder Badge, TM39, healing and original-menu saving in
both editions. It repairs Brock's long dialogue overwriting battle flags in the
WASM build. Full fresh-boot movies of 211,487 FireRed and 253,043 LeafGreen
frames pass on desktop and mobile browser workers, and both original GBA games
accept the resulting saves. Later-game, hosted-account and capacity qualification
remain open; the repaired cores retain disabled production capabilities.

## Multiplayer infrastructure qualification

The agreed target is 1,000 simultaneous active players, with original-level unranked battles and one-for-one live trades. `npm run engine:benchmark-gameplay -- build/game-source/firered` measures the checked adventure route with 16-frame state digests and checkpoints in actual scenes; select the LeafGreen directory for its route. `npm run engine:benchmark-mixed` exercises concurrent adventures, battle, trade and lobby polling through the real local API, WebSockets and pooled Postgres, including an adventure reconnect and atomic trade completion. Mixed and battle benchmarks now account for API and child-process CPU/RSS together, counting each PID once, and retain tagged reports instead of replacing evidence. Matched small-load thread/process runs pass; their resource sums are not per-player production estimates. Run finite jobs through the guard described above. The exact workloads, source identities, measurements and limits are documented in [engine/PERFORMANCE.md](engine/PERFORMANCE.md). Larger concurrency, distributed recovery and a hosting estimate are still required before provisioning that capacity. The next hosted-account setup is specified in [infra/STAGING.md](infra/STAGING.md).

The initial [account database migrations and restricted API role](infra/RUNTIME-ROLE.md)
now pass actual Supabase CLI/native PostgreSQL checks. The API can reserve names,
create both slots, save/recover a session and coordinate battle/trade database
transactions through a non-admin login. The migrated schema matches the complete
declarative state. These use synthetic data-access fixtures; hosted signup,
SMTP and the selected Linux service remain pending.

## License

MIT. See [LICENSE](LICENSE).
