# Kanto Online: adventures, combat and a shared collection

Direction recorded October 17, 2026. Multiplayer combat remains the first major
milestone. HeartGold/SoulSilver, cross-generation transfers, a shared Pokédex
and community seasons extend that foundation. They are not public capabilities
yet. Automated checks reduce defects; they do not establish complete game
coverage or physical-device performance.

## Current implementation

Accounts can keep up to three independent FireRed adventures and three
LeafGreen adventures. Each has an immutable adventure UUID, its own original
cartridge save and its own revision. The migration preserves existing saves as
slot zero. Old edition-based save URLs continue to address only slot zero.
New clients identify saves by adventure UUID and bind a running game to the
selected slot. A guest game must select an empty destination; syncing cannot
silently replace an unrelated existing adventure. Creating another adventure
does not delete or restart an earlier one. No slot deletion is exposed.

The browser reuses integrity-checked, content-addressed WASM bytes across
adventures and restarts. Cache corruption causes a verified download retry;
unavailable storage falls back to downloading. Only the selected game runs.
Solo play no longer computes periodic verification digests or sends unused
input journals. Authenticated verified play and trades retain their journals.
The comparative worker check advances the same actual C game with both modes
and compares pixels, flash and frame count. The battle viewer also reuses its
image buffer; forfeit confirmation blocks game controls behind the prompt.

The platform catalog contains four game identities, but the playable engine
protocol still accepts only the two supported GBA editions. A HeartGold or
SoulSilver save cannot be mistaken for a 128 KiB GBA cartridge.

The shared Better Auth identity and restricted game schema are now migrated on
Netlify. Actual main-UI account, multiple-adventure and battle journeys pass
locally, including exact-slot recovery and unchanged solo saves. Public game
execution, solo-progress promotion, cross-generation conversion and community
score ledgers remain unfinished. Current release evidence is
`build/netlify-accounts-release-1792255070/`; the public entry point remains the
solo player.

The HTTP battle viewer now passes a complete original-C local match and
desktop/mobile recovery checks on PostgreSQL 18, including explicit tab
ownership and fair request handoff. Its [qualification record](infra/REQUEST-BATTLE-API.md)
separates that evidence from unfinished hosted Function execution and public admission.

## HeartGold/SoulSilver research

| Project | What was verified | What is still needed |
| --- | --- | --- |
| [pret/pokeheartgold](https://github.com/pret/pokeheartgold/tree/708163e10169173d2bbab252538231721d983155) | A work-in-progress disassembly that reconstructs both US DS games; pinned README, build instructions and move/ability constants inspected | Portable browser runtime, hardware boundaries, remaining assembly and browser save/input/render/audio support |
| [ClickingMaster/ssrecomp](https://github.com/ClickingMaster/ssrecomp/tree/93ee2e93f5e73961eb0e7a0a68ceac453377c1b4) | SoulSilver ARM9 code is translated to C++; melonDS supplies DS hardware and ARM7. The inspected CMake file targets SDL-based native builds and Android | An actual Emscripten/WASM build, browser-compatible scheduling and threads, graphics/audio/input integration, HeartGold qualification and measured mobile performance |

The second project is a useful technical lead, not a drop-in web core. It also
contains interpreter fallback and depends on the melonDS runtime. A browser
port must account for that hybrid architecture and its GPL-3.0-or-later source
distribution requirements. Neither project is installed in Kanto's engine
registry. Research snapshots and hashes are retained under
`build/hgss-research-20261017/`; no ROM, proprietary SDK or generated game-code
download was performed for this research.

The first DS port gate is a pinned, reproducible headless WASM boot and native
save readback, followed by a browser title screen, touch/buttons, sound and
save/load. The next gate compares recorded input against the native reference.
Threaded rendering needs a tested browser isolation/header strategy and a
fallback for unsupported devices. Benchmark memory, compile time, download
size and sustained frame pacing before adding the game to the playable
library. HeartGold needs its own artifact and test evidence; a SoulSilver
build alone does not qualify both editions. Building the game-specific output
will require an available source build or matching local game assets.

## Custom cross-generation rules

Nintendo's original implementation migrated GBA Pokémon into the DS games;
it did not offer reverse transfers or direct GBA-versus-DS link battles.
See the [SoulSilver instruction booklet, migration section](https://csassets.nintendo.com/noaext/image/private/t_KA_PDF/DS_Pokemon_SoulSilver).
The owner's requested direction is intentionally different:

| Source | Destination | Requested route |
| --- | --- | --- |
| HeartGold or SoulSilver | FireRed or LeafGreen | One-way transfer, National Pokédex 1–151 only, subject to complete compatibility validation |
| FireRed or LeafGreen | HeartGold or SoulSilver | Disabled under the current requested direction |
| Within the GBA pair | Within the GBA pair | Existing native trade system and original trade evolution rules |
| Within the DS pair | Within the DS pair | Future native DS trade adapter |

The transfer direction follows the requested HGSS-to-GBA route. The shared
battle format below is a proposed implementation. Cross-generation execution
remains disabled pending native conversion and qualification. The
code in `packages/games/compatibility.ts` assesses policy only; it cannot convert
a native record, move a Pokémon, enable a battle or award progress.

Species number is only the first check. A Gen IV Pikachu can have a later move
that the GBA engine cannot represent. The policy rejects moves beyond the
Gen III move set, and requires a reviewed species-specific move/ability oracle
even for earlier move IDs. For example, U-turn is 369 in the inspected DS data,
while the GBA move set ends at 354. Gen IV abilities, eggs, unsupported forms,
unmapped held items and invalid levels are also blocked. The initial bridge
requires held items to be removed. Nothing is silently discarded or replaced.

The native converter must additionally preserve or explicitly account for
personality, trainer IDs, shininess, gender, nature, IVs, EVs, experience,
friendship, PP/PP Ups, nickname/OT text encoding, ribbons, origin fields and
Pokérus. Destination stats must be computed by the target game's rules.
Some DS origin metadata cannot fit in the GBA record: preserve its provenance
in the central ledger and qualify an explicit destination representation.
Both native record checksums/encryption and full save integrity must validate.

TM/HM inventory stays in its original adventure. A learned move must be
representable and valid for the destination species. Field use follows the
destination game's badges and scripts: transferring a Pokémon with Surf does
not grant a new trainer access to Surf outside battle. HM removal requirements
must be explicit in the adapter; no destination move is silently erased. A
one-way transfer is migration, so the proposed rule does not trigger trade
evolution; ordinary same-generation trades retain native trade evolutions.

## Battles across generations

Both sides must resolve a match with one engine and one declared ruleset.
Gen III and Gen IV cannot simply exchange native link packets: move behavior,
abilities and the physical/special split differ.

The proposed first shared format is **Original 151 · Gen III · earned levels**.
Both complete parties pass the same compatibility checks and are converted
into isolated copies for the existing original-C GBA battle engine. The DS
player would see the shared GBA battle scene for this format, then return to
the DS adventure. Both players see the format before accepting. Their actual
adventure saves, levels and learned moves are preserved. Unrepresentable teams
are rejected with a move/ability-specific explanation before the match starts.

Same-generation formats can retain their native engines and species ranges.
A later normalized-level format should be separate, with temporary level/stat
normalization qualified independently. Ranked results must be grouped by
format; earned-level and normalized-level battles cannot share a rating pool.
The first 151 includes Mew and Mewtwo; no unstated species ban is imposed.

The immediate battle milestone is two real Kanto accounts completing:
challenge → acceptance → original intro → player decisions → move animation
and sound → damage/status → faint/switch → final result → return to adventure.
The local prototype already implements much of this with the original C code.
Actual Better Auth accounts, explicit adventure selection and exact-slot
recovery now pass locally. Hosted execution, broader mechanics/audio checks
and hosted recovery qualification remain. Browser-uploaded solo saves are not
already verified battle progress. A [Netlify execution experiment](infra/NETLIFY-GAME-EXECUTION.md)
finishes the same original match across 168 fresh workers; it measures recovery,
not public API or capacity readiness. The [native HTTP implementation](infra/REQUEST-BATTLE-API.md) now completes the full original match with actual accounts, durable clock/receipt recovery, SQL rollback and independent personal pictures. Missing controls are neutral, so a peer cannot stall a decision by withholding button batches. Its browser/Netlify integration and capacity qualification remain unfinished.

## Central trading and collection

The ownership ledger should assign each Pokémon a stable central identity and
one active location: account, adventure, game and storage slot. Native PID or a
record hash alone is not a unique lifelong identity. Ordinary in-game edits,
evolutions and trades can change record bytes.

A transfer reserves the exact source Pokémon and source/destination adventure
revisions. The native adapters prepare and validate replacement saves outside
long database transactions. Final commit checks the reservation fence, both
revisions and record identities, then atomically removes the source, inserts
the destination, updates native Pokédex flags and appends a single durable
receipt. Retries return that receipt. A crash or conversion failure before
commit leaves ownership and both saves unchanged. Syncing or another trade
must not overwrite a reserved adventure. Same-owner transfers between separate
adventures need their own supported path and award no trading points.

The shared account Pokédex records seen and owned species separately, retaining
the first verified registration and origin history. Registering Pikachu in four
adventures is one account collection entry. A central profile display is not a
substitute for the native game's Pokédex flags, which must also be updated by
the destination adapter. Future collections can span 493 species while the
cross-generation Kanto bridge remains restricted to 151.

## Community progression

The proposed community layer adds all-time collection progress, weekly
discovery/badge challenges and format-specific battle standings. Weekly windows
start Monday 00:00 UTC, with historical boards preserved. A new week does not
reset an adventure, Pokémon or lifetime Pokédex.

`packages/community/scoreboard.ts` contains an initial, unpublished scoring
policy: 25 points for a first badge in an adventure, five for a first account
species registration and ten for a completed eligible battle win. At most two
wins against the same opponent score in a week. Aborted matches, self-matches,
unverified uploads and repeat registrations score nothing. These are tunable
proposal weights, not a live economy or ranked rating implementation.

Only durable events issued by the authoritative game/battle/trade service may
reach scoring. An account cookie, a client-supplied `verified` flag or an
uploaded save does not prove an achievement. The calculation module expects
complete registration history so earlier discoveries cannot be counted again;
the eventual database ledger must enforce unique achievement and battle event
identities. No public score-submission endpoint or sample leaderboard is shipped.
Before ranked launch, address opponent collusion, account farming, moderation,
late events, corrections and auditable season finalization.

## Acceptance gates and order

1. Finish the public two-account GBA battle journey, including real disconnects,
   duplicate input, replaced tabs, timeouts, worker failure and unchanged saves.
2. Preserve multiple-adventure identity through battle/trade admission and
   recovery. Local account and battle integration passes; publish hosted execution
   and qualify the new account role through the native trade journey.
3. Establish the shared owned/seen Pokédex from verified events, then publish
   weekly boards with deterministic receipt deduplication and UTC boundaries.
4. Qualify a DS browser core independently, then its native record/save adapter.
5. Enable a cross-generation transfer only after native source removal,
   destination insertion, Pokédex updates, save readback and fault/retry checks.
6. Qualify the shared battle format against target-engine reference results
   across moves, status, items, abilities, switches, evolution-related forms
   and both players' perspectives. Measure real network and physical devices.

The existing 1,000-active-player target still requires a measured mixed-load
deployment and cost review. A small local benchmark or the existence of a
native recompilation does not establish browser throughput or hosted capacity.
