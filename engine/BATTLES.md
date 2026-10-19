# Original-C link battles

The experimental battle core runs two original FireRed/LeafGreen consoles with
the original battle master, controller commands, menus, damage, fainting and
switching. Authenticated challenges, durable sessions and interactive browser
controls are connected for isolated local qualification. All battle artifact
capabilities remain false. The live browser player has confirmed accounts and
solo cloud saves, but reports online battles unavailable. Its Better Auth
sessions are integrated locally with the multiplayer API and main UI.

`build/game-account-migration-v6-battle-ui-report.json` finishes an original-C
battle on desktop and mobile with actual SDK-created accounts, the shared
identity migration and restricted game credentials. It covers both screens,
reload recovery, logout revocation, fresh-login recovery and unchanged
adventure saves. Opening the forfeit prompt releases held controls and blocks
keyboard, touch and gamepad inputs. The viewer reuses its decoded image buffer.

The main UI also completes account creation, multiple-adventure selection,
challenge/acceptance, forfeit and exact-adventure return against the actual API
in `build/netlify-accounts-check-1792243993267/main-browser-report.json`.
Input-earned cartridge fixtures and client experimental status admission remain
explicit test fixtures. All three identity/slot/game migrations are applied in
production, but hosted battle execution is unfinished. The public entry point
remains the solo player. See [account integration](../infra/BETTER-AUTH-MULTIPLAYER.md).

The [bounded HTTP adapter](../infra/REQUEST-BATTLE-API.md) separately completes
an original-C match through actual HTTP and restricted Postgres transactions.
Its durable clock, idempotent response receipts and neutral missing controls
survive independent invocations. This adapter is not yet the browser's battle
transport and has not been deployed as a Netlify Function.

## Source and transport

`port/kanto_battle.c` loads a server-owned cartridge through the original save
and encrypted-party loader. It calls the original `HealPlayerParty`, matching
`CableClub_EventScript_EnterColosseum`, on the isolated RAM copy. Earned levels
are preserved. The source cartridge remains untouched throughout the battle.
The temporary map header is the original two-player Colosseum, so terrain-based
moves use its indoor rules independently of either adventure's field location.

Both consoles exchange original link identity metadata, then original headers,
six-member parties and battle controller blocks through bounded 256-byte
endpoints. The original `CB2_HandleStartBattle` selects player zero as the
battle master for these two variants. The other console runs its original
player/link-opponent controllers and displays its own perspective. Original
controller commands and return values handle player decisions; JavaScript
does not calculate moves, damage, AI, or replacement Pokemon.

`prepare_battle.py` checks five pinned source files:

- `link.c`: memory endpoints replace physical `SendBlock`, received-block
  flags, identity/count queries and cable-close dispatch while the experimental
  transport is active. Sequence checks, bounded lengths, duplicate detection
  and backpressure are private C state.
- `battle_controllers.c`: the original send/receive tasks run without physical
  cable negotiation; actual received controller blocks enter the original
  copying/acknowledgement logic.
- `battle_main.c`: the start callback recognizes this transport and the final
  link-battle callback stops the isolated scene after the original outcome.
  A read-only helper reports the original master's decision phase and the
  sides still required to choose.
- `battle_controller_player.c`: a read-only helper identifies original action,
  move and forced-replacement requests, including visits to the Summary screen.
- `menu_helpers.c`: original party/summary menus recognize the active server
  transport and preserve its tasks. Omitting this destroys the transport
  during a forced switch and leaves both consoles waiting for an acknowledgement.

No fabricated RFU/remote-player flags are set. Original turn selection, turn
ordering and battle-end mechanics remain unchanged; source preparation rejects
drift or repeated transformation. Original battle interfaces, including the
forced-switch menu, still receive explicit player buttons.

`packages/battles/original-core.ts` binds this private ABI. Rendered screens
are copied into standalone 153,600-byte buffers; their `.buffer` cannot expose
the rest of a console's memory.

## Builds and qualification

Run `npm run engine:build-battle -- --version firered` and repeat for LeafGreen
after building the ordinary source/data objects. This recompiles only the five
reviewed boundaries and shares existing source/data/dependencies. Output goes
under `build/game-source/<version>/battle/`; the earlier adventure/trade
candidates, saves and qualification evidence remain in place.

The battle experiment defaults to 16 MiB of linear memory per console. The
linker checks its mutable layout and normal runtime bounds still apply.
`--memory-mib 64` reproduces the earlier memory setting. The retained FireRed
two-member-party 64 MiB artifact/report is under `qualified-memory64/`. Its
controller-block hash, outcomes and frame counts match the 16 MiB run. This
reduces allocated linear memory fourfold; it is not a 1,000-player capacity
measurement or a hosting quote.

`npm run engine:check-battle` runs FireRed against FireRed. Pass a candidate
directory to select LeafGreen, or two directories for a cross-version match.
Set `KANTO_BATTLE_PARTY_FIXTURE=ordinary` for the original-C-created two-member
pre-trade fixture cartridges. The default uses real early-adventure saves.

The checked matrix covers both versions and cross-version pairs, with one-
and two-member parties. It verifies:

- Both original battlers initialize at their earned starting levels; the
  original master applies damage and both consoles report opposite outcomes.
- Two-member parties finish through the original forced-switch interface.
- Packed private checkpoints recover both cores during the intro and, for the
  two-member cases, while the original party menu is visible.
- Fresh instances replay the recorded player buttons and reproduce every
  controller block, final frame and final canonical digest.
- Immutable source assets and both adventure cartridges remain unchanged.
- Wrong peer identity, oversized/reordered blocks and wrong acknowledgements
  are rejected; retransmitted blocks are idempotent.

Reports, button journals, packed checkpoints and sampled original framebuffers
are retained beside each battle artifact. The A/Down input policy is explicitly
a qualification driver; it is not an automatic production choice policy.

## Authenticated sessions and browser privacy

Battles keep both cores on the server and send each player their rendered
screen. This keeps original controller buffers and pending choices off both
browsers. `packages/battles/screen.ts` implements bounded keyframes and changed
8×8 RGBA tiles, with frame/sequence checks and atomic decoder validation.
The authenticated WebSocket uses bounded compression and output queues. There
are no game rules in this viewer codec.

`BattleRepository` reserves the current two adventure revisions while both
trainers are in the lobby. Only the challenged player can accept. A battle
never writes either canonical cartridge, revision, earned levels or experience.
The isolated original cores heal their temporary parties as the Colosseum does.

`BattleSessions` owns a single server clock for the two consoles. Browser
commands contain only held buttons, their own sequence and operation ID. ACKs
follow database commit. Private progress journals retain both source hashes,
derived link-block hashes and C decision metadata. Exact-artifact packed
checkpoints plus journal replay recover the pair; lease fences and connection
epochs reject stale workers and replaced windows. Reconnect clears held buttons
and grants no extra simulation time. The original final result is persisted
with the final progress entry and takes precedence over later forfeits.

Original C requests start a 90-second choice window, including one-sided forced
replacements. A 60-second disconnect grace period and a one-hour match limit
also apply. Recovery preserves deadlines. Expired startup reservations and
abandoned matches return both adventures to the lobby. Engine uncertainty
requires verified recovery and cannot manufacture a winning side.

The lobby provides challenges, acceptance, decline and resume. `Battle` renders
only the player's screen, with keyboard, touch and gamepad controls, reconnect,
explicit forfeit and return to the lobby. `/api/battle-play` requires the
configured origin, a confirmed account and participant authorization. It does
not serve WASM, seeds, private memory, peer controls or link packets.

`KANTO_CHECK_ORIGINAL_BATTLES=1 npm run db:check-local` qualifies the actual C
pair against disposable Postgres, including checkpoint/journal restoration in
a new worker, stale-worker rejection, durable original completion and unchanged
canonical adventures. Its clock and button policy are explicitly test drivers.

`KANTO_CHECK_BATTLE_UI=1 npm run db:check-local` runs the real lobby and battle
components in fresh desktop/mobile browser contexts against HTTP, WebSocket,
Postgres and both original C cores on the wall clock. It exercises a challenge,
acceptance, controls, reload/rejoin, original result and return to the lobby.
The isolated Auth `getUser` fixture verifies the production authentication path;
it does not prove hosted signup, confirmation email delivery or deployment.
Reports are `build/battle-service-report.json` and `build/battle-ui-report.json`.

`npm run test:battle-browser` checks the actual decoder in fresh desktop and
mobile-emulation browsers using original cross-version battle framebuffers.
Canvas pixels match the source bytes for both perspectives, a fresh keyframe
recovers a missing delta, and the viewer downloads no WASM or checkpoint.
This is a screen-viewer check, not an interactive authenticated PvP journey.

The older two-choice `BattleSession` remains a separate contract test; the live
original-C integration uses `OriginalBattlePair` and `BattleSessions` instead.
The pair now runs inside a bounded, reusable worker thread pool. Each worker
owns one match; artifact validation, original C execution, private link hashes,
checkpoint encoding/compression and screen copies happen there. The API owns
authorization, clock budgets, database leases, durable acknowledgements and
personal socket routing. Matches advance independently, so one slow worker does
not block other match clocks or the API event loop.

`BATTLE_WORKERS` sets 1–32 workers per API process, defaulting to at most four.
Workers start lazily and are reused after a match. Capacity exhaustion returns
a retryable error and releases startup reservations. Requests have a bounded
queue and a 15-second worker timeout. Exit, crash or timeout invalidates that
worker's consoles; a fresh worker restores exact checkpoints and the verified
journal. No application database or Auth environment settings enter a worker.
The managed `NODE_OPTIONS` preload is preserved.

This is CPU and JavaScript-isolate separation within one process. Node's
JavaScript heap limits do not bound WASM memory or prevent whole-process memory
failure; the trusted battle artifacts have a separate linear-memory admission
limit. Cross-machine routing and container/process memory isolation remain
required. See the [Node worker documentation](https://nodejs.org/api/worker_threads.html).

`node --experimental-strip-types scripts/check-battle-workers.ts` compares
every decision, progress digest and private transport hash against an inline
original-C replay. It kills a worker during an advance, restores a checkpoint,
checks the other worker stayed intact, verifies private screens, enforces pool
capacity and reuses a worker with fresh consoles. Its report is
`build/battle-worker-report.json`. The battle benchmark and its limits are
documented in [PERFORMANCE.md](PERFORMANCE.md).

Still required: dedicated hosted account/adventure qualification and independent
original-GBA battle comparisons,
more moves/statuses/items and parties, full adventure coverage, process/container isolation,
physical-device QA, compression/bandwidth measurements and mixed 1,000-player
load qualification also remain before public release.
