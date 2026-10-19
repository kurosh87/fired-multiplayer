# Private game workers

Adventure verification, original link battles, trade scenes and party inspections use bounded local worker
pools. Threads remain the local default; `GAME_WORKER_TRANSPORT=process`
selects separate private worker processes for all four pools. Database connections, confirmed-account checks, ownership,
durable journals, lease fences and browser sockets remain in the API process.
Workers receive pinned game artifacts and trusted cartridge/checkpoint bytes.
They do not inherit database or Auth environment configuration. The managed
`NODE_OPTIONS` preload is preserved; inherited `--env-file` arguments are not.

`ADVENTURE_WORKERS`, `BATTLE_WORKERS`, `TRADE_WORKERS` and `INSPECTION_WORKERS` each accept 1–32 workers per API
process. Their defaults use at most four workers each. They start lazily and
are reused after a runtime closes. An adventure worker owns one authoritative
game; a battle worker owns the two original consoles for one match. Each live
trade scene owns one trade worker. Inspection workers handle short party and
eligibility requests separately, so live scenes cannot consume their capacity. Admission
is bounded, pending RPCs are bounded and a 15-second timeout invalidates a
failed worker. Capacity errors leave durable progress recoverable.

The shared transport is `packages/engine/private-worker-pool.ts`. A lease
belongs to one runtime, including across a worker restart. Late replies and
old handles cannot act on its replacement. CPU, canonical state hashing,
checkpoint packing/compression and original lobby save preparation run inside
the workers. Trade preparation, original eligibility checks, party inspection,
evolution and move-learning scenes also run there. The API receives compressed checkpoints and bounded metadata;
it does not copy a 64 MiB adventure snapshot on ordinary pause or save paths.

## Adventure durability

`SessionVerifier` supports both synchronous engines and private asynchronous
engines. It acknowledges a button batch only after the original game advances,
its digest is computed, and the database journal transaction commits. An
uncertain execution or persistence result poisons that runtime. Resume uses
the exact artifact, a private checkpoint and the committed input journal;
session identity, sequence, frame and canonical input fingerprints are checked.

Checkpointing pauses input acceptance and waits for pending work. The worker
returns an encoded, compressed snapshot plus original cartridge bytes. The
database update checks the current fence, frame and next input sequence. A
worker holding an old fence cannot reacquire another worker's unexpired lease.
Database lease comparisons use wall time even inside a long transaction,
using PostgreSQL's [clock_timestamp](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).

Reconnect and pause do not grant new simulation time. Only a new session's
first input receives the initial jitter allowance. Restoring a later sequence
starts with zero credit and excludes offline time. Unacknowledged speculative
frames are discarded after a worker failure.

Entering the lobby saves on an isolated original-C clone inside the worker.
Original field/menu/party restrictions still apply. The staged cartridge and
post-save runtime checkpoint commit atomically before the live runtime closes.
Returning restores that post-save runtime. Ordinary adventure input and
checkpoint requests do not write the canonical cartridge slot. Exit mirrors
the verified original-menu cartridge; erased flash is not presented as a save.

## Current evidence

`KANTO_CHECK_ADVENTURE_WORKERS=1 npm run db:check-local` exercises real
FireRed and LeafGreen C/WASM with disposable Postgres. It replays 26,560 and
26,774 recorded frames respectively, including the starter, first rival result
and original-menu save. Every acknowledged digest matches an independent C
instance, and the saved cartridge matches the separately qualified route.

The check kills an executing worker before acknowledgement, verifies that no
speculative frames reached the journal, restores checkpoint plus committed
tail, and rejects an immediate retry without fresh clock credit. It checks
original lobby guards, the qualified lobby-save bytes, unchanged live runtime,
atomic cartridge handoff, post-save resume and exit/reopen. The clock and fixed
seed are explicit test drivers, never browser API inputs. The report is
`build/adventure-worker-report.json`.

Battle worker comparisons, in-flight termination and private pixel parity are
described in [BATTLES.md](BATTLES.md). Its measured workload and transport costs
are in [PERFORMANCE.md](PERFORMANCE.md). Browser trade/evolution/move-choice
qualification also runs against the shared verifier after these changes.

## Trade durability and inspection

`TradeWorkerPool` prepares both original scenes from the reserved cartridges,
rechecks selected Pokemon digests, exchanges original peer packets, applies
original eligibility rules and packs both initial checkpoints inside a worker.
Each participant then drives their own worker through the existing button
verification protocol. No normal scene checkpoint copies 64 MiB into the API.

The final advance reply includes original completion status and a copied result
cartridge. The API journals that cartridge atomically with the final input
before acknowledging it. Both completed outputs must match the reserved
adventures before the existing transaction commits either canonical save.
Cancellation, expiry and worker failure cannot commit a single participant's
cartridge. A replayed completed scene must reproduce the staged result exactly.

`WorkerGameInspection` runs party inspection and two-party eligibility checks
on a separate bounded pool. These operations create temporary original-C
instances and return metadata or original rule codes. Artifact validation,
record decoding and Pokemon identity hashes stay inside workers. The API still
checks ownership, save revisions, offer revisions and both confirmations.

`KANTO_CHECK_ORIGINAL_TRADES=1 KANTO_CHECK_TRADE_UI=1 npm run db:check-local`
checks cross-version ordinary trades and the original Poliwhirl-to-Politoed
evolution with Perish Song learning. An in-flight worker kill must leave its
input uncommitted, leave the peer scene intact and recover without new clock
credit. Every acknowledged digest and both output cartridges match independent
C instances. A complete first scene leaves both canonical saves untouched.
The browser check covers offers, confirmation, actual scenes, mid-trade reload
and atomic completion in desktop/mobile emulation. Evidence is retained in
`build/trade-scenes-report.json` and `build/trade-ui-report.json`.

## Process transport

The process transport forks `packages/engine/private-worker-process.ts` with
only the managed `NODE_OPTIONS` environment value. It forwards neither account
and database credentials nor inherited `--env-file` arguments. The supervisor
keeps its own event loop free and runs one game worker thread inside the child
address space. Parent IPC loss exits the entire child even when that game thread
is hung in synchronous work. A failed lease cannot use the replacement worker;
retiring slots stay unavailable until termination completes.

Advanced IPC copies byte payloads. Receivers create exact, separately owned
buffers so a private battle screen cannot expose another screen or serialization
envelope through its backing ArrayBuffer. Thread mode retains its existing
transfer behavior. Both transports keep the admission/RPC bounds, 15-second
failure timeout, artifact validation, canonical hashes and durable-before-ack
fencing. Each lease still owns one adventure, one trade scene or one battle pair.

`tests/private-worker-pool.test.ts` checks capacity, environment stripping,
separate process identity, byte-buffer ownership, peer isolation, in-flight
termination, stale handles, reuse, an install/close race and cleanup after an
API parent's abrupt loss while the game thread is hung. The process qualification
replays both original adventures (26,560 and 26,774 frames), ordinary and
move-learning trades, and the 10,076-frame original battle with private screens
and recovery. `scripts/check-worker-transports.ts` also checks both editions in
both modes against inline original C and compressed checkpoint restoration.

The actual desktop/mobile earned-Pokémon browser journey passes with process
workers: lobby save, audio, trade/reload, atomic commit, committed-cartridge
boot, original Continue, unlocked field and save/exit. Both unchanged GBA games
accept its resulting cartridges and match earned party and recorded storage
bytes. Consolidated evidence is `build/process-worker-validation.json`.
These are local fixtures; hosted signup and physical devices are separate.

Use `KANTO_WORKER_EVIDENCE_TAG` for new adventure/battle worker reports and
`KANTO_UI_EVIDENCE_TAG` for trade/UI reports. Run finite qualifications through
the project guard. Earlier reports and artifacts remain retained.

## Private resource observations

`PrivateWorkerPool.resources()` reads the existing private `metrics` operation
on every live slot, including idle slots that still retain a Node runtime,
artifacts and baselines. It does not acquire a game lease or advance game state.
The `kanto.private-worker-pools` Node diagnostics channel publishes
`{event: 'opened' | 'closed', pool}` at pool construction and shutdown. This is
an in-process capability for trusted diagnostic code; there is no HTTP route,
browser message or account permission that exposes it. No polling occurs
without a diagnostic consumer.

The benchmark subscribes before creating pools and samples at 250 ms intervals,
with one sample in flight at a time. Each sample sums RSS once per PID; CPU
uses per-process counter deltas. Thread workers share the API process and its
RSS/CPU totals must not be summed per slot. Process workers contribute their
whole child process, including its supervisor and game thread. See the
[Node process resource documentation](https://nodejs.org/api/process.html#processmemoryusage)
and [diagnostics channel documentation](https://nodejs.org/api/diagnostics_channel.html).

Reports retain all samples and their collection durations. The summed RSS peak
is the maximum observed sum in a sample, rather than a sum of unrelated
per-process peaks. Shared pages across processes remain included in each RSS;
this is not physical-memory deduplication. Slot and PID membership must stay
fixed during a measured window. New/replacement workers make that comparison
fail, so warm every pool first; failure/restart capacity requires its own
measurement method. Metrics RPCs use the same bounded queue and their overhead
is included. This instrumentation does not add a hard resource limit.

## API process restart and shutdown fences

Adventure shutdown now increments the writer fence when expiring its database
lease. A WebSocket disconnect checkpoint can already be in flight as shutdown
captures progress and closes its game worker. Expiring the timestamp alone left
the old fence valid: the late checkpoint could extend the lease by another
minute. Revoking the fence makes that late checkpoint update match no row,
while a replacement process can claim the released session immediately.
An expected stale checkpoint may log `SESSION_LEASE_LOST` during this race;
it cannot renew ownership or replace the released checkpoint.

`scripts/check-api-restart.ts` qualifies this through the production `createApp`
API in isolated child processes, real HTTP/WebSockets and the owned native
Postgres cluster. It resumes the retained input-earned FireRed/LeafGreen field
checkpoints. Each API acknowledgement must match an independent original-C
instance's frame and digest. A private test-only IPC command blocks each next
append after C has advanced and before the real Postgres write begins; the test
then sends SIGKILL to the actual API process. Both uncommitted advances are
discarded, the committed journal tail survives, and both game children exit.

The replacement API rejects takeover while the existing lease is live. The
test waits for the real database lease to expire, without changing its
timestamp or injecting a clock. Both games then restore their frame, sequence
and digest, return the original acknowledgement on retry, and continue.
An immediate accelerated batch is rejected after recovery, so the offline
wait does not bank game-clock credit. SIGTERM must checkpoint both sessions,
revoke their old fences and expire their leases. A third API process resumes
both adventures immediately, accepts more original-C inputs and saves/exits.
Canonical cartridges remain unchanged until that explicit exit.

Run with a fresh evidence tag:

```sh
KANTO_RESTART_EVIDENCE_TAG=your-fresh-restart-run python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- python3 -B scripts/check-database.py --restart
```

The initial failed run and exact source are retained under
`build/api-restart-v1-check.log` and `build/api-restart-source-v1`: the real
SIGTERM check exposed the renewed-lease race. The fixed two-edition run is
`build/api-restart-v2-report.json`, `build/api-restart-v2-check.log` and
`build/api-restart-source-v2`. It waited 59.36 seconds for the remaining live
lease after the replacement API started. The dedicated `kanto_restart_*`
databases are retained for inspection; the launcher stops its Postgres server.

This is a local process/recovery qualification with an isolated Auth provider
and trusted experimental artifacts. It does not qualify the production main
entry/configuration, a hosted Linux/container deployment, hosted signup/email,
battle/trade API restarts, physical browsers or 1,000 concurrent players. There
is no browser or production route for the fault-injection commands, no artifact
capability promotion and no hosted database change.

## Remaining scope

Thread mode shares the API's OS process. Process mode provides separate address
spaces and crash containment, with a child supervisor for parent-loss cleanup.
It does not supply container permissions, network isolation or a hard RSS cap.
JavaScript heap limits do not bound WASM/external allocations. The
trusted artifacts have a separate 64 MiB initial-memory admission limit per
console. Container/host resource limits and cross-machine ownership/routing are still
needed. This architecture is not yet a qualified 1,000-player service.

Request-time original game execution now uses local worker pools. Dedicated hosted account
qualification, complete adventure/postgame coverage, physical mobile devices,
private object storage, mixed database/socket load and a priced deployment
remain before public release. Public artifact capabilities remain disabled.
