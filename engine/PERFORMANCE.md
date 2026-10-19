# Development measurements

Measured October 16, 2026 on an Apple M4 Pro, 12 logical CPUs, macOS arm64, Node 26.5.1. These are single-session runs with the current experimental C/WASM engine, not concurrent-player qualification or a hosting quote.

The adventure measurements below precede the record-layout correction and trade extension.
The rebuilt candidates hash about 2.52 MB of mutable state. The timings below remain
tied to the explicitly listed measured artifacts; remeasure the final integrated
engine before estimating production capacity.

The benchmark replays the same recorded adventure used by `engine:check-gameplay`: 26,560 FireRed frames or 26,774 LeafGreen frames, including a starter, original rival battle and menu save. It advances real game code, computes a digest every 16 frames, and measures snapshots at the bedroom, starter selection, rival battle, after the rival result and saved game. Its final digest must match the separately checked gameplay snapshot.

## Verification cost

| Measurement | Before memory partitioning | Current |
| --- | ---: | ---: |
| FireRed median digest per batch | 8.42 ms | 2.18 ms |
| LeafGreen median digest per batch | 8.43 ms | 2.18 ms |
| FireRed median simulation per batch | 14.29 ms | 14.41 ms |
| LeafGreen median simulation per batch | 14.29 ms | 14.24 ms |
| Canonical bytes hashed per batch | 9,768,652 | 2,515,388 |

The linker now separates fixed assets from mutable data instead of hashing fixed assets repeatedly. Original ARM writable data and BSS remain mutable, including music track state. Gameplay checks confirm that excluded asset bytes remain unchanged. The artifact's SHA-256 still pins all code and initial data. Both hosts use the same state serializer.

This reduces median hashing time by about 74%. Total simulation and digest CPU extrapolates linearly to roughly 61 development-machine cores for 1,000 sessions, versus roughly 84 before partitioning. This is a diagnostic extrapolation only: it excludes journals, database latency, sockets, checkpoint CPU, contention, worker isolation and deployment overhead. It is not a tested capacity or machine recommendation. Rendering is still performed in server instances to deliver original scanline callbacks and DMA correctly.

## Checkpoint storage and transfer

| Format | Compressed bytes across measured scenes |
| --- | ---: |
| Previous full-memory gzip, before partitioning | 9,622,720–9,656,273 |
| Current full-memory gzip | 5,262,170–5,295,200 |
| Current packed pages plus gzip | 147,616–179,664 |

The packed representation uses changed 4 KiB pages relative to the exact artifact's seed-zero baseline. It preserves the complete 64 MiB memory image. Each measured checkpoint is decoded and compared byte for byte with its source snapshot. It is also used for real browser-worker restoration and private database recovery followed by input-journal replay.

In these runs, page encoding took about 9–20 ms, gzip about 3.5–4.4 ms, and decoding about 1.8–6.3 ms. Current full-memory gzip took about 148–152 ms. Initial per-artifact baseline generation is measured separately and its baseline is shared across server sessions.

Each live instance still reserves 64 MiB of linear memory. Multiplying that reservation by 1,000 gives 62.5 GiB; this is not a measured resident-memory requirement. Browser reconstruction and server snapshot copies have additional temporary memory costs. Physical mobile-browser coverage remains outstanding.

## Reproduce

```sh
npm run engine:check-gameplay -- build/game-source/firered
npm run engine:benchmark-gameplay -- build/game-source/firered
npm run engine:check-gameplay -- build/game-source/leafgreen
npm run engine:benchmark-gameplay -- build/game-source/leafgreen
```

On this Mac, run finite jobs through the project guard wrapper described in the root README. The generated `gameplay-benchmark.json` records the exact artifact, replay SHA-256, hardware/runtime, phase timings and memory measurements. Earlier comparison reports are retained under ignored `build/benchmarks/`.

Current measured artifacts: FireRed `firered-rev1-cd551d2c6a-3c2e3b13ea8d`; LeafGreen `leafgreen-rev1-cd551d2c6a-a7bf2510aeda`. Before partitioning: FireRed `firered-rev1-cd551d2c6a-4752647c20b0`; LeafGreen `leafgreen-rev1-cd551d2c6a-c228b0a6b86b`.

Public release remains disabled. Remaining capacity work includes private object storage, process/container isolation, mixed adventure/PvP/trade workloads, database and network failure recovery under concurrency, and a measured deployment estimate.

## Original link battles with local worker isolation

Measured October 16 on the same development machine and Node 26.5.1, using
FireRed `firered-rev1-cd551d2c6a-d53d1b2c6902` and LeafGreen
`leafgreen-rev1-cd551d2c6a-647208286e16`. Both consoles reserve 16 MiB each.
These measurements use the independently qualified 10,076-frame cross-version,
two-member-party movie, including original forced replacements. Every measured
match must reproduce its qualified final state digests. This is a development
microbenchmark for one or two simultaneous matches, not 1,000-player qualification.

The cores execute in the actual bounded worker pool. Progress digests follow
15-frame boundaries or button changes; private packed checkpoints are compressed
every 600 frames. Personal screens use the current tile codec and real loopback
WebSockets with level-3 permessage-deflate and no context takeover. The two local
viewers decode the messages and must reproduce the final source pixels.

| Measurement | One match / 2 players | Two matches / 4 players |
| --- | ---: | ---: |
| Simulated time per match | 168.70 s | 168.70 s |
| Measured wall time | 22.97 s | 23.19 s |
| Total process CPU, including local viewers | 24.27 CPU-s | 49.11 CPU-s |
| Main-thread CPU, including measurement clients | 0.99 CPU-s | 2.07 CPU-s |
| Worker advance RPC, median / p95 | 6.93 / 7.21 ms | 6.91 / 7.34 ms |
| Progress digest RPC, median / p95 | 4.38 / 4.44 ms | 4.39 / 4.56 ms |
| Packed checkpoint RPC, median / p95 | 10.25 / 17.33 ms | 11.22 / 18.41 ms |
| Warm-worker checkpoint restore | 46.65 ms | 43.63–45.96 ms |
| Compressed screen TCP bytes, whole workload | 1,563,141 | 3,126,282 |

Screens averaged 4,633 bytes per simulated player-second in this movie. A
straight-line extrapolation gives about 37 Mbit/s for 1,000 battling players,
before TLS/IP overhead, control/ACK messages, account requests and retries.
The same CPU extrapolation gives roughly 72–73 development-machine cores,
including the local viewers and benchmark driver but excluding database work,
authentication and cross-machine routing. These figures are diagnostics; they
do not establish a provisioned machine count, bandwidth commitment or price.

Peak whole-process RSS was about 841 MB and 858 MB respectively. That includes
fixture preparation, artifact buffers, cached baselines, workers and local
WebSocket clients; garbage collection and allocator reuse affect the baseline.
It must not be treated as measured production RSS per player. Worker JavaScript
heap limits also exclude WASM linear memory and other external allocations.

The main event-loop histogram used 10 ms sampling and observed p95 of
11.3–11.4 ms. This is not an HTTP or durable input-acknowledgement latency
measurement. Warm restore timings exclude a cold worker's artifact installation
and subsequent journal replay. The recorded input movie runs faster than real
time and does not exercise distributed clock admission, database contention,
network loss or mixed adventure/trade traffic.

Reproduce through the shared guard:

```sh
node --experimental-strip-types scripts/check-battle-workers.ts
node --experimental-strip-types scripts/benchmark-battles.ts
```

`KANTO_BATTLE_BENCH_CONCURRENCY=1,2` is the default; each selected count is
bounded at eight. `build/battle-benchmark.json` records artifact IDs, hardware,
CPU breakdowns, memory observations, timing distributions, packet counts and
pixel parity. `build/battle-worker-report.json` separately proves recovery after
killing a worker during execution and that another worker's match stays intact.
Adventure verification now uses the shared private-worker transport; its real
C/Postgres qualification is in [WORKERS.md](WORKERS.md). Trade verification and
lobby-party inspection also use private workers. Private checkpoint
storage, larger mixed-workload database/socket tests, process/container failures,
cross-machine routing and a priced deployment remain before public launch.

## Concurrent database and socket workload — October 16, 2026

The same benchmark source ran two 45-second wall-clock windows through the
actual HTTP/WebSocket API, original C/WASM workers and an independent
ten-connection Postgres pool: one with 64 MiB adventure/trade cores and one
with the [16 MiB candidates](MEMORY.md). Reports are
`build/memory-64-mixed-benchmark.json`, `build/memory-16-mixed-benchmark.json`
and `build/memory-sizing-report.json`. `build/mixed-benchmark.json` holds the
latest run. All reports keep public/capacity qualification false.

Each run used two adventures from saved cartridges, a two-player earned-level
battle, an ordinary cross-version trade and two lobby pollers. Input drivers
use scripted A-button pulses. Both trade scenes completed; each battle was
partial and then forfeited. Configuration and source hashes match across runs.
Trusted random battle seeds and wall-clock scheduling are independent, so the
battle journals contain different numbers of batches. This is a small local
comparison, not a fixed-frame CPU comparison or 1,000-player qualification.

| Operation | Samples per run | p95, 64 MiB cores | p95, 16 MiB cores |
| --- | ---: | ---: | ---: |
| Durable adventure acknowledgement | 333 | 32.34 ms | 32.58 ms |
| Durable trade acknowledgement | 218 | 26.72 ms | 26.63 ms |
| Battle button acknowledgement | 470 | 21.86 ms | 22.05 ms |
| Lobby HTTP and reconnect setup during measurement | 27 | 79.78 ms | 48.43 ms |

Each run committed 333 adventure and 218 trade journal batches; battle journal
counts were 406 and 449. Five pool connections overlapped in each run, the
sampled pool queue remained empty, and Postgres reported no deadlocks. Sampled
input acknowledgements matched committed journal rows read through another
pooled connection. Final adventure checkpoint digests matched durable
acknowledgements. Socket reconnect preserved the adventure frame, sequence and
digest, taking 184 ms and 153 ms including an explicit 100 ms disconnect wait.
Both trainers received the same trade receipt, both traded save revisions
advanced exactly once, and unrelated canonical cartridges stayed unchanged.
Both personal battle screen streams decoded successfully.

Sampled whole-process peak RSS was 1,942,077,440 bytes (1.81 GiB) with the
64 MiB cores and 1,282,637,824 bytes (1.19 GiB) with the 16 MiB cores: an observed
659,439,616-byte (34%) reduction. Linear memory per adventure/trade core fell
from 64 to 16 MiB (75%); the separate battle cores already used 16 MiB.
Process CPU during the measurement windows was 32.51 and 32.84 CPU-seconds over
45.94 and 45.91 seconds elapsed. Main-thread CPU was 4.31 and 4.45 CPU-seconds.
Event-loop delay p95 was 12.17 ms in both runs at 10 ms histogram resolution.
These samples do not establish a CPU improvement or production RSS per player.

RSS includes retained artifact/baseline allocations, workers and local socket
clients/decoders. CPU and acknowledgement measurements cover the live workload
window; fixture preparation/startup CPU is excluded. Local clients and the
isolated Auth fixture share the measured process. Postgres runs separately, so
its CPU is excluded. Browser adventure simulation, TLS, external networking,
hosted signup/email, object storage and distributed routing are excluded.
Garbage collection and allocator reuse also affect observed memory. A hosting
quote and 1,000-player sizing still require broader qualification.

Reproduce through the shared guard. On this Mac, the task-local disk override
is appropriate only while authorized by the operator:

```sh
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- python3 -B scripts/check-database.py --mixed
KANTO_QUALIFICATION_MEMORY_MIB=16 python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- python3 -B scripts/check-database.py --mixed
```

`KANTO_MIXED_SECONDS` accepts 40–180 seconds; the default is 45. The launcher
keeps Colima off and stops its project-owned Postgres cluster afterward. Each
run retains a separate `kanto_mixed_<timestamp>` database for inspection and
accepts only the project-owned Unix-socket test cluster. It never resets an
existing run or accepts `DATABASE_URL`. The report pins schema, server and
package source hashes and artifact IDs, and refuses success if sources change
during the run.

Earlier benchmark/UI reports remain under `build/benchmarks/`; the source and
artifact changes are traceable through their pinned identities. The initial
failed driver attempt remains in `build/mixed-benchmark-attempt-1.log`: its
reconnect batch arrived too early and the verifier correctly rejected it.
The passing driver waits through full frame intervals with a 2 ms scheduling
margin. Production clock limits are unchanged.

## Process-transport measurement scope

The retained workload numbers above describe the thread implementation and
must not be reused as a process-mode hosting quote. Process workers add private
Node runtimes, supervisor/IPC copies and separate RSS. Their private metrics now
include PID, transport and process CPU, alongside thread CPU and memory. Measure
API RSS plus child RSS once per distinct PID; in thread mode, reported RSS is
the shared process total and must not be summed per worker.

`build/process-transport-smoke.json` records 1,200-frame startup observations
for each edition and mode. These are point-in-time RSS observations, not peaks,
matched-load comparisons or capacity measurements. The process transport's
correctness/recovery checks do not establish 1,000-player sizing, container
resource limits, distributed routing or a costed deployment.

## Matched thread/process resource measurements

Measured October 16, 2026 on the same M4 Pro and Node 26.5.1. The new
schema-version-2 reports separate API-only counters from API-plus-worker
resources. The mixed pair uses the same 16 MiB adventure artifacts, 16 MiB
battle consoles, configured pool sizes and 45-second wall-clock workload:
two adventures, one two-player battle, one two-player trade, and two lobby
pollers. Pools are warmed before recording a fixed slot/PID set. Both runs
retain one API process; process mode additionally retains seven private
worker processes, including idle inspection/trade slots.

| Mixed workload | Thread | Process |
| --- | ---: | ---: |
| Measured resource window | 45.93 s | 45.95 s |
| Distinct measured processes | 1 | 8 |
| Peak sampled summed RSS | 1.214 GiB | 2.523 GiB |
| Peak API-only RSS, sampled separately | 1.216 GiB | 0.468 GiB |
| Total measured process CPU | 32.85 CPU-s | 35.01 CPU-s |
| Adventure acknowledgement p95 | 34.53 ms | 33.86 ms |
| Trade acknowledgement p95 | 28.01 ms | 26.76 ms |
| Battle button acknowledgement p95 | 23.93 ms | 26.50 ms |

Both runs committed 333 adventure and 218 trade input-journal batches,
preserved the adventure reconnect frame/sequence/digest, reproduced durable
checkpoint digests, committed exactly one two-save trade, and decoded both
personal battle screens. Five pooled Postgres checkouts overlapped, with no
sampled queue or reported deadlock. The mixed battle is partial and ends in
an explicit forfeit. Wall-clock scheduling produced 468/466 battle button
acknowledgements and 390/402 battle journal rows; this is a matched
configuration, not identical battle input histories or repeated statistical
sampling. The modest latency/CPU differences do not establish a performance
advantage for either mode.

The separate fixed 10,076-frame original battle replay does reproduce identical
qualified final digests, screen pixels and 1,563,141 compressed TCP bytes in
both modes. Each case runs one match/two viewers faster than real time:

| Fixed battle replay | Thread | Process |
| --- | ---: | ---: |
| Workload wall time | 22.94 s | 23.68 s |
| Total measured process CPU | 24.36 CPU-s | 26.15 CPU-s |
| Peak sampled summed RSS | 0.659 GiB | 0.807 GiB |
| Worker advance RPC p95 | 7.20 ms | 7.38 ms |
| Warm checkpoint restore | 48.30 ms | 48.36 ms |

The sampler takes a boundary reading and samples every 250 ms, never queuing
multiple samples concurrently. It requests each live worker's whole-process
RSS/CPU, adds the API process, and deduplicates by PID. CPU is the sum of each
process's own counter delta; thread workers' copies of API CPU/RSS are not
added again. The reported RSS peak is a maximum of sampled sums, rather than
a sum of peaks observed at different times. Node documents the
[process-wide RSS semantics for threads](https://nodejs.org/api/process.html#processmemoryusage)
and [process CPU counters](https://nodejs.org/api/process.html#processcpuusagepreviousvalue).

Mixed runs each retained 185 samples; collection took up to 32.08 ms in thread
mode and 23.89 ms in process mode. Battle cases retained 93/96 samples with
maximum collection durations of 7.12/7.30 ms. Readings are asynchronous within
that collection span and can miss short allocation peaks. API-only RSS uses
the separate pre-existing 25 ms timer, so its thread peak can exceed the
250 ms sampled total slightly. Raw samples, individual process counters,
collection spans, pool/slot membership and exact source hashes are retained.
Worker or slot membership changes invalidate a measured comparison.

Sampling RPC overhead and local clients/Auth fixtures are included. Startup
CPU, Postgres CPU, browser adventure simulation, hosted Auth/email, TLS,
external networking and distributed routing are excluded. RSS includes
artifact caches, baselines, runtime/JIT allocations and allocator retention;
pages shared across processes are counted in each process's RSS. These sums
are not deduplicated physical RAM and must not be divided by player count to
quote production memory. The API-only process-mode figure understates this
workload's summed RSS substantially; use the aggregate resource report.

Evidence: `build/resources-{thread,process}-v1-mixed-benchmark.json` and
`build/resources-{thread,process}-v1-battle-benchmark.json`, with frozen source
in `build/process-resource-source` and the guarded log
`build/process-resource-benchmark-check.log`. The previous reports remain
retained. These four local runs establish correct resource accounting and
small-load observations, not Linux/cloud capacity, hard RSS limits,
1,000-player service, or a hosting quote.

Reproduce with a fresh tag for each transport; the drivers refuse to replace
existing evidence. Set `GAME_WORKER_TRANSPORT=thread` for the matching thread
case and use the same memory/workload settings:

```sh
GAME_WORKER_TRANSPORT=process KANTO_QUALIFICATION_MEMORY_MIB=16 KANTO_BENCH_EVIDENCE_TAG=your-fresh-process-run python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- python3 -B scripts/check-database.py --mixed
GAME_WORKER_TRANSPORT=process KANTO_BATTLE_BENCH_CONCURRENCY=1 KANTO_BENCH_EVIDENCE_TAG=your-fresh-process-run python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/benchmark-battles.ts
```
