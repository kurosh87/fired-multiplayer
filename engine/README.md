# Game engine boundary

The browser and server must run the same FireRed/LeafGreen WASM artifact. Experimental source-built candidates for both versions run recorded adventures through a starter, first rival result, original save, Continue and reset/reload. They are retained under `build/game-source/{firered,leafgreen}/`, separate from the application artifact registry. Actual desktop/mobile browser-worker replay matches headless state hashes, including a replacement worker restored mid-adventure. This establishes early execution and cross-host determinism, not complete original-game fidelity or public readiness.

The portable lane compiles 290 C units from the pinned native FireRed reference and converts 361 original script/music assembly data files per variant. `compile-game.py`, `build-game-data.py` and `link-candidate.py` implement that pipeline. The original-source header preparation below is a separate audit lane; the working native lane already provides portable register headers.

Compilation preserves the matching Thumb compiler's four-byte minimum record alignment, exempting packed records. `engine:test-record-layout` compares 111 saved-record sizes/member offsets with pinned agbcc; this includes mail, recap, PC storage and later save fields beyond the party. The experimental original-C trade scene and its qualification matrix are described in [EXCHANGE.md](EXCHANGE.md). Public trade routes remain disabled pending interactive account/lobby integration and durable recovery.

Run `npm run engine:prepare` after the guarded original-source fetch. It validates SHA-256 hashes of reviewed inputs and generates a frame-stepped main loop, hardware headers and DMA macros in ignored `engine/generated/`. When integrating those headers, preinclude the generated definitions/register headers: the upstream relative includes otherwise take precedence over `-I` order. Define `KANTO_WASM`, use `-fno-strict-aliasing`, and link the hardware/DMA implementation. Original vendor files remain untouched.

The generated headers redirect register, palette, VRAM, OAM and BIOS interrupt/sound slots to aligned linear-memory storage. All register offsets and derived addresses stay in the original headers. Button writes implement the GBA's active-low `KEYINPUT` encoding.

DMA helpers route to a portable controller with 16/32-bit copy/fill, increment/decrement/fixed addressing, delayed blanking transfers, repeat/reload, count-zero semantics and pending completion interrupts. Its latched channel state lives alongside the hardware memory for snapshots. Special/FIFO/capture transfers fail explicitly until their controllers exist. The scheduler must invoke `KantoDmaTrigger` at real blanking boundaries; direct register enabling and interrupt write-one-to-clear behavior still require source integration. This is not cycle-accurate bus emulation. [DMA semantics reference](https://mgba-emu.github.io/gbatek/#gba-dma-transfers).

The candidate delivers scanline/HBlank/VBlank callbacks and DMA during the shared frame step, using the compiled C renderer on both hosts. Timer emulation, raw EWRAM/IWRAM operations outside the boot/reset boundary, physical device behavior and full graphics fidelity remain incomplete. `npm run engine:test-platform` executes C hardware, DMA and libc behavior checks and checks wasm32 layout; these checks pass locally.

The title's Timer 1 entropy boundary has a portable counter: all 32 trusted boot-seed bits influence its 16-bit origin, and it advances by 280896 clocks per simulated frame. The original `SeedRng` and trainer-ID logic remain in C. No wall clock, browser randomness or client-chosen seed is used. Reset retains the trusted origin. `engine:check-entropy` exercises distinct upper seed bits, delayed title input, fresh-instance checkpoint replay and reset in both actual games. This supplies deterministic entropy rather than general instruction-cycle timer emulation. [Frame timing reference](https://github.com/mgba-emu/mgba/blob/26b7884bc25a5933960f3cdcd98bac1ae14d42e2/include/mgba/internal/gba/video.h), [timer reference](https://github.com/mgba-emu/mgba/blob/26b7884bc25a5933960f3cdcd98bac1ae14d42e2/src/gba/timer.c).

`kanto_scheduler.c` and `kanto_stack.s` isolate the game's C stack from the ABI-call stack and keep both its suspension descriptor and Asyncify stack in canonical memory. Binaryen replaces the four temporary `asyncify.*` control imports with internal functions. The final artifact accepts no host imports. Each step returns after exactly one hardware frame, including waits inside synchronous map loading. `npm run engine:test-scheduler` has executed nested waits with live C arrays, unrelated stack-heavy ABI calls and checkpoint resumption in a fresh instance. The only explicit Asyncify exclusion is the assembly stack-switch wrapper; do not exclude game callbacks or indirect calls.

Binaryen's function-cast pass runs before Asyncify. It preserves original ARM callback conventions such as discarded results or extra arguments, including the script engine's mixed-return special table. Otherwise valid original-game calls trap under WASM's strict indirect-call types. The relocation contract and coroutine contract execute these cases, including a cast callback that suspends and resumes. [Binaryen implementation](https://github.com/WebAssembly/binaryen/blob/version_133/src/passes/FuncCastEmulation.cpp).

Warm reset unwinds the game coroutine before restoring its linked RAM initializer. `reset_memory.py` changes active data segments to passive segments and adds a cold initializer plus a checked replacement for `kanto_reset.s`'s deliberately trapped placeholder. Data bytes, relocations, table indices and existing function indices remain unchanged. WASM bulk-memory instructions clear BSS and restore initial data without a duplicate asset buffer or host imports. Cartridge flash survives outside the reset region, and the verified session frame count stays monotonic. `engine:test-reset-memory` executes initialized-data/BSS reset, live ABI-stack preservation, function pointers and fresh-instance checkpoint cases. The real FireRed reset chord followed by Continue also passes. Revision-1 build metadata uses the original fixed date, rather than the build machine's wall clock.

`port/elf_data.py` converts GNU-assembled ARM data objects into relocatable WASM assembly. It preserves original data bytes, labels, data pointers and function-table references using C compiler signatures. It rejects executable ARM sections and unsupported relocations. `npm run engine:test-data` has passed an actual ARM assembler → converter → WASM compiler/linker → Node execution round trip, including indirect function calls and negative pointer addends. The full FireRed data object also links and boots; later script and music coverage remains to be qualified.

The converter preserves writable initialized data and NOBITS/BSS separately from read-only data. In particular, original music track state belongs in mutable memory. The two-pass candidate link reads the actual `.rodata`/`.data`/`.bss` partition, embeds its mutable boundary, relinks and rejects any layout change. Unknown or overlapping memory partitions fail. Per-batch serialization includes all mutable game state and both coroutine stacks; immutable assets are pinned by the artifact hash. Gameplay qualification compares the excluded bytes with the original initializer after boot, the adventure, Continue and reset.

The C exports are declared in `include/kanto_abi.h`. The required platform boundary is in `port/kanto_platform.h`. All platform behavior affecting simulation must run identically in the browser and headless server. No unresolved WASM imports are accepted.

## Artifact manifest

Build each variant with a manifest named `artifacts/firered.json` or `artifacts/leafgreen.json`, beside its corresponding `.wasm` file. This is the schema, not a runnable artifact:

```json
{
  "id": "firered-rev1-COMMIT-BUILD",
  "version": "firered",
  "revision": 1,
  "abi": 1,
  "wasmSha256": "64 lowercase hexadecimal characters from the actual WASM file",
  "upstreamCommit": "40 lowercase hexadecimal characters from the pinned source",
  "status": "experimental",
  "capabilities": {
    "adventure": true,
    "battle": false,
    "trade": false,
    "audio": false
  }
}
```

IDs must contain only lowercase letters, numbers, dot, underscore and hyphen; the uppercase words above denote build-time substitutions. Never mark an artifact `verified` because its checksum matches alone. Require real game reference checks, browser/server replay parity and recovery tests. Multiplayer capability flags require actual original-game adapters.

## Execution and snapshots

- The runtime supplies erased or canonical 128 KiB flash before boot. Client saves never become authoritative.
- A frame step accepts only the ten GBA buttons and bounded frame counts.
- All mutable state, including PRNG state, frame counters, timers, DMA state, flash, and game globals, must reside in linear memory at public call boundaries.
- State serialization is canonical and excludes framebuffer/audio output and its own scratch buffers. Rendering cannot mutate the hashed state.
- Full-memory snapshots are accepted only from trusted server storage and only for the exact artifact, ABI and memory layout.
- `packages/engine/checkpoint.ts` packs changed 4 KiB pages against an artifact-specific baseline. It reconstructs every byte, including output, scratch and both stacks; it does not trim state or translate game saves. The baseline uses an identical fresh-instance call sequence on both hosts: erase flash, boot seed zero, serialize state. Its WASM SHA-256, exact memory length, page count and page order are checked before reconstruction. Server storage and browser download use gzip over this format; prior private full-memory snapshots remain readable. This encoding is not authentication for uploaded saves.
- Each loaded server artifact keeps one baseline, shared across its sessions. Live instances still reserve 64 MiB; packed transport does not make them small or isolated. Private object storage and distributed workers remain required before public scale.

## Qualification

`scripts/verify-engine.ts` runs the same artifact twice in Node and checks supplied reference digests and checkpoint round trips. Its output labels this **headless parity**, not real-browser parity or complete gameplay compatibility. Add browser replay checks against independently recorded GBA baseline screenshots before promotion.

`scripts/benchmark-engine.ts` measures idle boot only and acquires the local resource lease. It makes no 1,000-player claim. Qualification additionally needs overworld, wild/trainer battles, save/restore, journaling, checkpoint storage, live PvP/trades and worker failures under load.

`scripts/benchmark-gameplay.ts` measures the actual checked adventure with 16-frame digests and checkpoints at gameplay milestones. It proves complete checkpoint memory round trips and compares the final state with the gameplay-qualified snapshot. Reports include machine/runtime identity, replay hash, step/digest percentiles, packing/compression timings and explicitly unqualified linear extrapolations. See [measured results and limits](PERFORMANCE.md).

Reference sources are pinned in `upstream.lock.json`. The experimental native FireRed reference covers early Android gameplay only; it supplies no validated LeafGreen, browser or multiplayer runtime.

Both unchanged revision-1 GBA baseline ROMs now match upstream checksums: FireRed `dd5945db9b930750cb39d00c84da8571feebf417`, LeafGreen `7862c67bdecbe21d1d69ce082ce34327e1c6ed5e`. `build-baseline.py` retains tool/source identities and checksums. `run-reference.py` uses pinned mGBA through its C API to replay actual inputs with a fresh erased save and no user configuration or cheats. The reference aligns frame zero to initialized `gMain` before the first callback; it measures that boundary instead of hardcoding a boot delay. `compare-reference.ts` compares RGB555 pixels and retains mismatches. The first FireRed run matched Oak's dialogue and the bedroom exactly; intro/title animation alignment remains under investigation. These tools never promote a candidate automatically.

`check-gameplay.ts` replays recorded buttons through the real core to a starter, first rival result and original-menu save. It checks canonical-state changes, a checkpoint in fresh runtime instances, fresh flash-based Continue, the original reset chord and another Continue. FireRed's winning route reaches level 6; LeafGreen has a separate losing route and level-5 recovery. `check-save-readback.ts` verifies that the exact generated flash was accepted by the checksum-matching original ROM and its Pokemon menu, with matching level/HP and no bad egg. Its proof is tied to the current candidate/save/reference hashes. Passing these checks does not mark a complete adventure or public release qualified.
