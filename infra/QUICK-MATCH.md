# Quick match and lobby presence

`QuickMatch` turns the lobby directory into one-click public matchmaking. Both
trainers queue from their verified lobby session; the server pairs the closest
waiting party and starts the match through the same authenticated challenge and
acceptance as a directory challenge. `private.lobby_presence` additionally
gives the directory a bounded party snapshot so trainers can pick opponents
(and filter) by earned progress without re-inspecting any cartridge.

No new admission path exists: pairing rechecks live lobby sessions and
unsuspended profiles in SQL, and a paired match runs `BattleRepository.challenge`
and `BattleSessions.accept` unchanged, so ownership, pinned save revisions,
artifact pinning and console reservation behave exactly like a directory
challenge. No original game bytes, private memory or full party inspection ever
leave the server: presence is species names, levels and a maximum level only.

## Presence snapshot

- `Sessions.enterLobby` writes `private.lobby_presence` in the same transaction
  that moves the session into the lobby, from the lobby staging result (up to
  six non-egg party entries: `{species, name, level}` plus `max_party_level`).
- `Sessions.lobbyState` backfills the snapshot for sessions that entered before
  the snapshot existed; a failed backfill never blocks the lobby itself.
- `Sessions.leaveLobby` deletes the presence row and any queue entry; live
  filters make stale rows inert in every other path.
- `GET /api/lobby/trainers` returns `party` and `maxLevel` via a left join, so
  older or fixture sessions without a snapshot stay discoverable with an empty
  party, and accepts `version` (`firered`/`leafgreen`), `minLevel` and
  `maxLevel` (1–100, both bounds inclusive) alongside `search` and `after`.
  Invalid values and unknown keys are rejected as `INVALID_TRAINER_SEARCH`.

## Pairing

`QuickMatch` (`apps/server/src/quick-match.ts`) is wired in `app.ts` next to
`BattleSessions` and registered by `registerBattleApi`:

- `POST /api/battles/quick` upserts the caller's queue row (session, version,
  snapshot level), opportunistically deletes entries older than ten minutes,
  then attempts one pairing. The response is `{status:'waiting',maxLevel}` or
  `{status:'paired',bootstrap}` — the paired side receives the full battle
  bootstrap, exactly like `accept`.
- `POST /api/battles/quick/cancel` is idempotent and returns `{status:'idle'}`.
- Candidate selection prefers a live entry whose snapshot level is within ±15
  of the caller; once either entry is older than a minute the band relaxes and
  any live waiting trainer is eligible, in queue order.
- A pairing claims both rows with **one conditional delete** over the two
  owner ids in sorted order (`date_trunc('milliseconds', enqueued_at)` guards a
  refreshed row). Parallel requests therefore cannot double-pair, lose an
  entry or deadlock; a claim that does not delete both rows aborts and restores
  whatever it removed.
- The server then challenges as the candidate and accepts as the caller
  (`BattleSessions.quickPair`). If the start fails, both rows are restored and
  the caller stays waiting; a partially created offer is declined immediately
  instead of lingering until it expires.
- A ten-second sweep (`QUICK_MATCH_SWEEP_MS`) expires abandoned entries and
  re-attempts pairing for entries older than the immediate window, so two
  trainers still meet when neither request happened to see the other. Every
  path rechecks session status, lease and suspension at selection time.

The lobby client shows a Quick Match card (find, searching with a stop control,
or continue a ready match) and hands a paired result straight to the battle
view. The card is scoped to the original API transport; the hosted
request-driven battle viewer has no queue endpoints, and the card is hidden
there. The trainer directory renders the party chips, an edition filter and a
"Near my level" toggle (±10 levels around the caller's own party maximum).

## Live directory push

`GET /api/lobby/trainers` stays the source of truth and the directory keeps its
20-second poll; the stream is additive. Every transition that changes who is
directory-visible (lobby enter/leave/state, battle reserve/release/finish, trade
reserve/commit/release) notifies the Postgres channel `kanto_lobby` with the
owner id inside the same transaction that commits the change, so a rolled-back
transition never notifies and a committed one is never missed.

`LobbyPresence` (`apps/server/src/lobby-presence.ts`) holds one dedicated
autocommit `LISTEN` connection outside the request pool
(`Database.listen`, `application_name='kanto-online-listener'`). A notification
is a wake-up, not a payload: the service re-reads the committed row, diffs it
against its in-memory map and publishes `put`/`del` to subscribers. A 50 ms
flush debounces bursts, a five-second stale check expires silent trainers, a
60-second reconcile re-reads the full bounded snapshot (drift larger than 40
rows is replaced by one `sync`), and a broken listener is replaced after two
seconds and rebased from committed state. The service is created whenever a
database is configured and starts on the first directory-stream connection: an
application that never streams opens no listener and performs no directory read
at boot, and a failed start is simply retried by a later connection. Hosted
Lambdas never call `createApp`, so no listener runs in production unchanged.

`GET /api/lobby-play` is a read-only authenticated WebSocket (owner-routed by
the gateway like `/api/play`). After `authenticate` the caller receives `ready`,
one `sync` baseline (the same bounded snapshot as the directory minus the
caller's own row) and incremental `put`/`del` messages; `refresh-auth`
revalidates the same account and the connection never accepts game input. A
trainer's own row is excluded from every message, one socket per owner is
enforced (a newer window takes over with `Presence resumed in another window`),
a session that is no longer in the lobby closes with `LOBBY_NOT_FOUND`, and the
stream closes with `1013` when the listener cannot start, so clients fall back
to polling. The stream is available whenever the lobby is — it serves trades and
the directory too, not only battle pairing — so it is not gated on
`multiplayer.battles`.

The web client (`apps/web/src/lib/lobby-directory.ts`,
`apps/web/src/lib/lobby-presence.ts`) merges events into the visible page only:
the active search/edition/level filters and the page cursor are applied, a full
window is trimmed to `LOBBY_PAGE_SIZE`, a sync keeps rows above its horizon
(capped snapshots cannot validate them) and the poll remains authoritative for
paging. The status line appends `· live updates` only while the stream is
connected, so a silent or blocked socket changes nothing.

The same socket carries the lobby's live battle list. `battle:<id>` wake-ups on
`kanto_lobby` are emitted in the transaction that makes a battle `active` and in
the one that finishes it (forfeit, timeout, disconnect and engine-error results
included), so a rolled-back transition never announces a battle. `LobbyPresence` re-reads the
bounded public projection and publishes one `live` message holding the full
list; a frame is filled in only by the node that hosts that battle's consoles,
and a frame-only change is not republished. A failed read leaves the list
unsupported until the next wake-up or reconcile, so a client never receives a
false empty list, and a service without a battle reader sends no `live` message
at all. The five-second `/api/battles/live` poll stays authoritative and keeps
running alongside the push, which makes the stream a latency improvement rather
than a new source of truth.

## Spectating

`GET /api/battles/live` is the authenticated lobby projection of battles whose
SQL status is `active`: up to 50 rows ordered by `updated_at` descending with
both handles, both editions, a frame when the answering worker hosts the battle
(`null` otherwise) and `startedAt` from the committed row. It reads only the
battle, profile and adventure tables — never a console, journal, save or input —
so a worker that does not host the battle can still answer, and the gateway
routes the list by verified owner (like `challenge`, `quick` and
`quick/cancel`). Only `/api/battles/:id…` and the battle socket pin work to the
worker that hosts the original consoles.

Spectating uses the existing `/api/battle-play` socket with
`{type:'authenticate',protocol:1,token,battleId,watch:{side:'a'|'b'}}`. The
server admits only profile-present, unsuspended accounts with a live lobby
session, then requires a non-poisoned in-process battle whose SQL status is
still `active`. The reply is the usual `ready` (`battle.side` is the watched
side) plus the first encoded keyframe for that side; afterwards the spectator
receives the same encoded screen packets an owner would receive. No input is
accepted: anything except `refresh-auth` closes the socket with `1008`. At most
ten spectators watch one battle (`1013` when full), one watch is allowed per
account (a new socket replaces the old with `Watch resumed in another window`),
a slow consumer is closed with `1013` instead of queueing deltas, `finished`
delivers the public result and closes `1000`, and `recovery-required` closes
`1012`. Each spectator has its own encoder and keyframes on the first encode,
so deltas stay ordered when two spectators watch different sides.

The web lobby lists live battles only for the original socket transport: the
presence stream pushes `live` replacements as battles start and finish, and the
five-second poll remains authoritative and fills in after a reconnect (the
hosted request-driven viewer has no live list). The list opens a read-only watch
screen with a side toggle, the public participants and the rendered canvas. It
never renders controls, party data, saves or journal state.

## Migration

`netlify/database/migrations/20261017180000_quick-match-presence/migration.sql`
adds `private.lobby_presence` and `private.quick_match_queue` with row security
forced and the same restricted `kanto_game_runtime` grants as the other
private game tables. Foreign keys target `kanto_preview.profiles(account_uuid)`
because `public.profiles` is a view. Netlify applies pending migrations during
a build-backed deploy (the draft-then-production path in
[Netlify accounts and deployment](NETLIFY-ACCOUNTS.md)); never run hosted DDL
by hand and never edit an applied migration. The migration is applied on the
private `kanto-battle-check` battle preview only — production retains six
migrations — and enables no public capability or engine flag.

`supabase/migrations/20261017180000_quick-match-presence.sql` adds the same two
tables to the ordered local migration chain, and `supabase/schemas/001_kanto.sql`
declares them for the disposable contract database. The parity gate
`python3 scripts/check-database.py --migrations` (the actual Supabase CLI on
the disposable PostgreSQL 17 cluster) proves the ordered migrations still
reproduce the declared schema exactly, and the hosted lane
`python3 scripts/check-database.py --netlify-preview` applies every Netlify
migration in order on a fresh PostgreSQL 18 database before the account, role,
HTTP-battle and browser checks. Latest evidence:
`build/database-migrations-v3/report.json` and
`build/netlify-accounts-check-1792259862358/report.json` (October 17 UTC).

## Qualification status

Contracts: `tests/quick-match-postgres.ts` runs queue, pairing, restore, cancel,
expiry, level-band and liveness cases against real SQL inside the disposable
database fixture (`tests/postgres.integration.test.ts`); `tests/quick-match-http.ts`
drives the same fixture application over its real HTTP surface — authenticated
enqueue, the claim/start path, failed-start restore, cancel idempotency and
leave-lobby cleanup of both the queue entry and the presence snapshot, plus 401
and `INVALID_BATTLE` guards. The fixture application reports no battle-capable
artifact, so its pairing start fails closed and must restore both entries; an
application that reports `multiplayer.battles` ready must instead return the
paired bootstrap and end the match through forfeit. `tests/lobby-discovery.ts`
covers the snapshot payload, filters, malformed values and unchanged pagination;
`tests/web.spec.ts` covers directory chips and filters plus the Quick Match card
round-trip (`Ready → searching → cancel`) and the poll-driven `Match ready`
handoff in the browser.

Slice 2 milestone 1 (live directory push) additionally covers:
`tests/lobby-presence.test.ts` (service map/diff, notification coalescing,
unchanged rows staying silent, lease expiry and renovation, reconciliation and
sync threshold, listener replacement, fail-closed baseline and retry);
`tests/lobby-presence-api.test.ts` (socket contract: ready → self-excluded sync
→ put/del, replacement windows, bad credentials and envelopes, refresh-only,
`LOBBY_NOT_FOUND`, origin refusal and `1013` when the listener is unavailable);
`tests/lobby-directory.test.ts` (client merge rules: filters, cursor, trimming,
next cursor, sync horizon); `tests/lobby-presence-journey.ts` in the disposable
database fixture (real snapshot/flush SQL, baseline exclusion of suspended,
expired-lease and busy trainers, unsuspension, lease renewal and expiry,
battle departure and return, party updates — plus one committed `pg_notify`
delivered to a real dedicated listener through `Database.listen`);
`tests/gateway.test.ts` and `tests/gateway-routing.test.ts` (owner routing for
the stream); and `tests/web.spec.ts` (a mocked directory stream marks the
directory live and merges a put and a del into the visible page).

The local native run (including slice 2 milestone 1) completed on October 17
UTC under the operator-authorized task-local disk reserve
(`scripts/run-local.py --allow-low-disk --min-free-gib 6`, free ≈13 GiB, normal
pressure): `npm run typecheck`; `npm test` (113 tests, 112 pass, one skip — the
disposable database contract runs in its own lane); the disposable database
contract (`python3 -B scripts/check-database.py`, real Postgres 17), whose
presence journey also proves one committed `pg_notify` ring delivered to a real
dedicated listener (report: `build/lobby-presence-report.json`); and the browser
lane (`node --experimental-strip-types scripts/check-web-local.ts
build/web-presence-m1`, 10/10 on desktop and mobile plus the production
compile) all pass. Run these with Node 24, matching CI: the default PATH Node
22.11 predates `require(ESM)`, which the database contract needs for Fastify's
`inject` dependency chain. The hosted migration is applied on the private
`kanto-battle-check` battle preview only; production retains six migrations
and no public capability is enabled.

Slice 2 milestone 2 (read-only spectating) additionally covers:
`tests/battle-watch.test.ts` (watch admission: missing profile, suspension,
non-lobby session and a battle that is not live on this worker; invalid battle
ids rejected before admission) and `tests/battle-watch-api.test.ts` (socket
contract: per-side keyframes and deltas, no owner traffic, read-only
enforcement, invalid watch envelopes, the ten-spectator cap, one watch per
account, `finished` → result → `1000`, `recovery-required` → `1012`,
`refresh-auth` and the authenticated live list). `tests/battle-postgres.ts`
adds the live projection and shared watch view to the disposable database
contract; `tests/gateway.test.ts` and `tests/gateway-routing.test.ts` cover
owner routing for `/api/battles/live`, `quick` and `quick/cancel`; and
`tests/web.spec.ts` drives the live panel into watch mode, the side toggle and
a real encoded keyframe/delta onto the canvas (12/12 desktop and mobile).
`tests/original-battle-sessions.ts` also asserts that a spectator's pixels are
byte-identical to the owner's own side and that suspension and non-lobby
admission fail against the real original-C battle. The engine-gated leg
(`KANTO_CHECK_ORIGINAL_BATTLES=1`) now passes. The earlier silent `test failed`
was a memory kill, not an engine assertion: the before/after
`select id,revision,flash from private.adventures` read every adventure in the
fixture, including large saves from earlier checks, and the post-battle result
grew the client process until it was killed without running JavaScript exit
handlers. The query also included the spectator adventure inserted after the
before snapshot. Scoping both snapshots to the two owners removes the unrelated
saves and the false mismatch. The passing run on October 19 UTC (local, under
the task-local disk reserve) rewrote `build/battle-service-report.json` with
`originalC:true`, frame-2000 checkpoint/journal recovery, 1,421 rendered screens
per side, the spectator pixel/admission checks and `result: finished`.

Slice 2 milestone 3 (live-list push over the presence socket) additionally
covers: `tests/lobby-presence.test.ts` (baseline read, start and finish
replacements, frame-only silence, a failed read that keeps the directory alive
and retries, reconciliation repair and the `battle:` wake-up payload);
`tests/lobby-presence-api.test.ts` (`ready` → `sync` → `live`, live
replacements, and no `live` message from a service without a battle reader);
`tests/lobby-presence-journey.ts` (a committed `battle:` NOTIFY delivered to a
real dedicated listener); and `tests/web.spec.ts` (a pushed live list replaces
the panel without waiting for the poll).

The local native run for slice 2 milestones 2 and 3 completed on October 19 UTC
under the operator-authorized task-local disk reserve
(`scripts/run-local.py --allow-low-disk --min-free-gib 6`): `npm run typecheck`;
`npm test` (128 tests, 127 pass, one skip — the disposable database contract
runs in its own lane); the disposable database contract
(`python3 -B scripts/check-database.py`, real Postgres 17); and the browser lane
(`node --experimental-strip-types scripts/check-web-local.ts
build/web-live-push`, 12/12 on desktop and mobile plus the production compile)
all pass. The engine-gated original-battle leg also passes on the same setup
after the scoped-save fix above. No production migration, capability flag or
public admission changed.

A successful pair through HTTP against the original battle core still needs a
battle-capable application registry; the fixture application deliberately
reports `battles: false`, so that leg is covered by the queue/start contracts
plus the engine-gated `KANTO_CHECK_ORIGINAL_BATTLES` qualification, and hosted
admission keeps waiting on the same engine and hosting gates.

## Non-goals

Realtime directory push and read-only socket spectating are implemented in
these milestones. Hosted request-driven spectating (the no-socket viewer path),
replay persistence, chat, a ruleset or level-50
choice, ranked play, badge display, Direct Corner staging and the Union Room
bridge remain later slices; the queue schema carries a `ruleset` column to keep
that door open without pretending the rules exist yet.
