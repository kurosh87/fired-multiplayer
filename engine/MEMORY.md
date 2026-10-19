# Smaller original-game cores

The adventure and trade candidates can be linked with 16 MiB of fixed WASM
linear memory. The retained comparison candidates use 64 MiB. The 16 MiB
builds reuse the same compiled original game/data objects and portable C
boundary. They have separate artifact identities and remain experimental.

| Version | Retained 64 MiB candidate | 16 MiB candidate |
| --- | --- | --- |
| FireRed | `firered-rev1-cd551d2c6a-af764a65fdc4` | `firered-rev1-cd551d2c6a-32b55352a660` |
| LeafGreen | `leafgreen-rev1-cd551d2c6a-8e6efdd2fbaa` | `leafgreen-rev1-cd551d2c6a-68ac436de4e8` |

The static/read-only/mutable boundaries are identical. Canonical state remains
2,517,460 bytes in each version. The conservative end of serialization scratch
leaves 2,931,480 bytes in FireRed and 2,932,312 bytes in LeafGreen within the
16 MiB allocation. The original game's fixed heap and record layouts are
unchanged. WASM download sizes remain approximately 13.5 MB.

## Direct comparison and original save evidence

`scripts/check-memory-candidate.ts` executes the same recorded inputs against
both sizes and compares serialized state bytes and rendered pixels at every
16-frame verification boundary and gameplay milestone:

- FireRed: 26,560 frames, 1,669 comparisons.
- LeafGreen: 26,774 frames, 1,683 comparisons.
- Packed checkpoints reconstruct the complete 16 MiB memory at every milestone
  and resume in fresh instances. Immutable original assets remain identical.
- Both final cartridges match the independently read-back 64 MiB saves byte
  for byte. Fresh Continue, the original reset chord, entropy and original
  lobby-save checks also pass with the smaller cores.
- The three trade matrices (FR/FR, LG/LG and FR/LG) produce the same 48 final
  cartridges as the retained original-GBA readbacks. Party bytes, mail, ribbons,
  Pokedex metadata, evolution, move learning and original eligibility are
  checked by the existing exchange/readback tools.

The reports are under `build/game-source/{version}/memory-16/`, including
`memory-parity-report.json`, `gameplay-report.json`, `lobby-report.json` and
exchange reports. Verification digests include the artifact ID, so different
artifact versions deliberately have different digests even when serialized
state bytes match.

## Reproducing the experiment

Run finite jobs through the shared resource guard. The task-local disk override
is appropriate only while authorized by the operator. No dependencies or
original-source trees need to be copied or installed again.

```sh
python3 -B scripts/link-candidate.py --version firered --memory-mib 16 --memory-experiment
python3 -B scripts/link-candidate.py --version leafgreen --memory-mib 16 --memory-experiment
node --experimental-strip-types scripts/check-memory-candidate.ts build/game-source/firered build/game-source/firered/memory-16
node --experimental-strip-types scripts/check-memory-candidate.ts build/game-source/leafgreen build/game-source/leafgreen/memory-16
```

`--memory-experiment` writes to `memory-N/` and preserves the existing candidate.
The normal linker default remains 64 MiB until a release artifact is selected.
The local qualification provider and temporary preview support
`KANTO_QUALIFICATION_MEMORY_MIB=16`; production artifact routing does not read
this setting. The optional setting accepts 16, 32 or 64, with 64 selecting the
retained default candidates. The separate experimental battle candidates use
16 MiB and keep their original identities.

## Worker, browser and workload checks

Both smaller cores pass the full recorded routes in desktop Chrome and mobile
Chrome emulation, including worker replacement and checkpoint replay. The cross-version
trade move-learning movie also passes in both browser configurations. The real
Postgres service checks repeat in-flight adventure/trade worker failures,
durable journal replay, clock-credit restrictions and atomic save handoffs.
The live trade UI repeats reload recovery and two-save atomic completion.
Preview tests verify boot and pause/resume on both viewport configurations;
physical touch-device QA remains open.

The same mixed HTTP/WebSocket/Postgres benchmark source was run once with each
size. Observed process peak RSS fell from 1.81 GiB to 1.19 GiB (34%) while
adventure/trade/battle-control acknowledgement p95 stayed around 33/27/22 ms.
The reports include local clients, Auth fixtures and allocator effects; this
is not production memory per player or a 1,000-player sizing result. See
[the complete measurements and limits](PERFORMANCE.md).

```sh
KANTO_QUALIFICATION_MEMORY_MIB=16 KANTO_CHECK_ADVENTURE_WORKERS=1 KANTO_CHECK_ORIGINAL_TRADES=1 KANTO_CHECK_TRADE_UI=1 python3 -B scripts/check-database.py
KANTO_QUALIFICATION_MEMORY_MIB=16 python3 -B scripts/check-database.py --mixed
KANTO_QUALIFICATION_MEMORY_MIB=16 node --experimental-strip-types scripts/preview-engine.ts
```

Keep exact 64 MiB artifacts for any sessions pinned to them. Checkpoint decoding
requires the original artifact hash and complete memory length. Canonical
cartridges remain readable by both builds; private runtime checkpoints remain
specific to their producing artifact. The experiment preserves all public
capability flags as false. Full adventure coverage, hosted accounts, distributed
workers and 1,000-player deployment qualification remain unfinished.
