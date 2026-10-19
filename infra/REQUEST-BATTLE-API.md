# Original-C battles over bounded HTTP requests

`RequestBattles`, `RequestBattleStore` and `requestBattleHttp` implement a
Request/Response transport for the existing private FireRed/LeafGreen consoles.
The native qualification runs actual HTTP, Better Auth accounts, restricted
PostgreSQL transactions and the source-built C battle. The transport is now
wired to a [private Netlify Function](NETLIFY-BATTLE-FUNCTION.md), with an actual
hosted account/worker/checkpoint journey. The browser viewer, explicit tab ownership and fair
writer handoff now pass a full local PostgreSQL 18 qualification. No public
battle route or artifact capability is enabled by this implementation.

## Account and adventure identity

Every request revalidates the confirmed Better Auth session and reserved
trainer profile. The server resolves membership and side from the battle row.
Challenges use the exact verified adventures already paused in the lobby;
acceptance pins their cartridge revisions, original artifacts and server seed.
Neither acceptance nor battle execution replaces an adventure cartridge.

Migration `20261017140706_request-driven-battles` adds private request state,
bounded personal input queues and immutable response receipts. It also indexes
the generated account UUID used by adventure metadata synchronization. The
account role cannot read these tables; only the restricted game coordinator
receives permissions. All three new tables force row security. The game role
receives no direct update/delete grant on accepted receipts. Parent-row
cascades remain an administrative retention concern. This migration passed native
qualification and is applied in production deploy `6ad391a74f5b1ce363efcd84`
(`build/netlify-accounts-release-1792250149/production-migrations.json`). The
request handler and browser viewer remain unpublished.

The additive fifth migration, `20261017152100_battle-control-connections`, is
applied on Netlify. It adds personal control epochs and append-only
connection records, plus recent writer/waiting timestamps for fair admission;
it does not change any already-applied migration. Runtime
changes that use these columns require this migration before admission.

The sixth migration, `20261017160200_game-runtime-role-switch`, explicitly
grants the deployment connection permission to enter the restricted game role,
without inheriting it by default or granting it to the account role. The actual
hosted preview had ADMIN membership with SET disabled. Native checks reproduce
that state using a non-superuser login, apply the exact migration, and verify
restricted transaction-local access and restoration. Role options follow the
[PostgreSQL GRANT contract](https://www.postgresql.org/docs/18/sql-grant.html).
Both migrations are applied in production deploy `6ad3a4e3ce306ae83fa3e14d`.
`build/netlify-accounts-release-1792255070/` records all six migrations, actual
preview restricted-role checks, production managed-role catalog checks and
unchanged solo gameplay. This deploy still does not include the battle Function.

Socket and request execution cannot simultaneously own a battle. Request
adoption requires untouched initial consoles and an expired worker lease;
socket claims explicitly reject battles adopted by the request transport.

## Routes and sequence contract

All routes are under `/api/online/battles`. They require a Bearer session token.
POST requests require the exact application Origin and JSON. The handler bounds
JSON bodies to 8 KiB and rejects unknown command fields. Responses use private,
no-store caching headers; raw errors and SQL details are not returned.

| Request | Operation |
| --- | --- |
| `GET /` | List this trainer's current challenges/battles |
| `POST /` with `{trainerId}` | Challenge another trainer in the lobby |
| `GET /:id` | Personal bootstrap, request sequence and input cursor |
| `POST /:id/open` with `{connectionId, expectedEpoch}` | Explicitly open or replace personal controls; retry the identical open after reply loss |
| `POST /:id/accept` with `{}` | Accept and initialize original consoles |
| `POST /:id/decline` with `{}` | Decline an offered challenge |
| `POST /:id/step` | Queue personal controls, advance admitted time and return a personal picture sequence |

A step body is:

```json
{
  "protocol": 1,
  "operationId": "2b63430f-107b-4918-bf38-90bcaef68bf5",
  "sequence": 0,
  "controller": {"connectionId": "74b31d7e-af60-4a65-9a68-780fb92b92c0", "epoch": 1},
  "action": "step",
  "runs": [{"buttons": 1, "frames": 1}, {"buttons": 0, "frames": 14}]
}
```

The example expresses a one-frame A tap followed by release. A request queues
at most 15 personal input frames and may lead the authoritative frame by at
most 30. `runs: []` polls without adding buttons. Input durations express a
trainer's controls; they do not grant simulation time. Clients cannot select
an owner, opponent inputs, authoritative frame, seed, checkpoint or outcome.

An operation UUID and sequence belong to one trainer in one battle. Repeating
an accepted request returns the identical stored compressed response, including
after a lost reply, service restart or battle completion. Changing its body or
reusing an accepted sequence with another operation fails. A concurrent claim
returns `BATTLE_REQUEST_BUSY`; retry the same request. An out-of-order request
does not change queues or progress. A reconnect reads the personal bootstrap
to resolve an unknown prior acknowledgement.

Writer contention also records authenticated live presence and a bounded
preference for the waiting side. The last successful writer yields its next
turn when that peer has requested work within two seconds. A stale preference
expires, so an abandoned request cannot indefinitely freeze play. The client
keeps its input buffer and current connection during these short retries.
Clock credit, input acknowledgement and request sequence do not advance from
a busy response. A retry of the latest accepted receipt can also refresh live
presence without changing the stored response bytes. Neither path revives a
trainer already absent for sixty seconds. The full native qualification covers
these admission changes and their regression cases.

The bootstrap also reports the caller's current `controllerEpoch`. A new tab
generates one connection UUID and opens against that epoch. A successful new
open increments the personal epoch, clears only that player's unprocessed
controls, and invalidates speculative work with the existing battle fence.
It preserves the opponent's queue, original frame, request sequence and clock
credit. Retrying the current connection UUID is idempotent. An older UUID
cannot reopen, submit buttons, retrieve old step receipts or forfeit after
replacement. A delayed first open against an outdated expected epoch also
fails; it cannot replace a connection opened since its bootstrap. Reconnect is
an explicit user action after replacement, rather than an automatic takeover.

`action: "forfeit"` requires an empty input array. A natural original-C result
already reached during a committed interval takes precedence over later
forfeit attempts. Public results and restoration of both lobby sessions commit
with the response receipt.

## Clock, recovery and fairness

Clock credit uses the exact GBA timing ratio, 280,896 CPU clocks per frame at
16,777,216 Hz. Database microsecond time refills persisted integer credit;
fractional credit survives requests and clock reversal cannot mint time.
Accumulated credit is capped at 75 frames. A request advances at most 60 frames.

Missing controls are neutral. A trainer who polls without sending button runs
cannot freeze the other console's selection or the original decision clock.
Late inputs start at the current authoritative frame or after already queued
personal controls. The server never rewrites
already committed inputs to backdate an arriving packet. Original-C decision
masks and 90-second decision deadlines survive checkpoint recovery. A trainer
absent from valid current requests/latest-receipt retries for 60 seconds loses by disconnect; two absent
trainers draw. The original battle expiration also remains enforced.

Execution uses two short transactions around an owned worker. The first claims
the exact revision/fence and reads durable state. The worker restores both
private consoles, applies queued/neutral buttons and renders both views. The
second commits queues, journals, full checkpoints, clock, personal cached
keyframes, result/lobby state and the receipt atomically. A stale fence, changed
revision or expired claim discards speculative work. No acknowledgement precedes
commit. Failed workers and receipt-write failures leave progress unchanged.

The local qualification now covers PostgreSQL 18.6, matching the inspected
Netlify database major, alongside the earlier PostgreSQL 17 evidence. Each transaction has an
8-second total deadline, a 1.5-second statement deadline, a 1-second lock deadline
and a 5-second idle-transaction deadline. Worker computation has an 8-second
watchdog and claims expire after 20 seconds. Read-only hosted probes verify
PostgreSQL 18.6 and the transaction-timeout setting. The Function's authenticated
hosted journey and managed-role adapter now pass their checks. Its complete
timeout/failure matrix and browser playback still need hosted qualification.

## Personal response format

Responses use `application/vnd.kanto.battle-response` with gzip content encoding.
Normal browser fetch decompresses them. `decodeBattleResponse` validates the
bounded binary envelope, public metadata and packet lengths. Its pictures use
the existing battle screen codec: a personal keyframe followed by ordered deltas.
Each independent response starts its own decoder sequence. Private WASM memory,
opponent pictures, controller buffers and pending decisions are never included.

The metadata contains only protocol, battle/operation IDs, the caller's sequence,
next sequence, side, authoritative frame, personal input cursor and public result.
A browser must ignore delayed or duplicate responses that precede its displayed
state. Battle audio is not implemented in this response transport yet.

The local `VITE_BATTLE_TRANSPORT=http` build routes lobby challenge/list/accept/
decline and the shared shadcn battle panel to the same-origin HTTP boundary.
It retains one in-flight operation across failed fetches, bounds sampled inputs,
latches quick keyboard/touch presses, decodes each response independently and
paces personal pictures without accepting an obsolete connection's response.
It releases controls during confirmation, blur and backgrounding. The default
build retains the existing socket transport. Desktop/mobile browser checks
cover the themed panel, short taps, reload, reply loss, tab replacement,
forfeit confirmation and lobby return without unexpected server failures.

The browser harness includes one explicit synthetic busy response while a
quick tap is buffered; the server's writer handoff and heartbeat behavior have
separate real-HTTP/PostgreSQL cases. Successful-case flags in the report are
written only after the corresponding journey finishes.

## Evidence and remaining work

`build/http-viewer-v8/report.json` passes all phases, including the complete
original-C HTTP match, current browser viewer, actual main account/adventure UI,
the original socket battle journey and solo account/save regressions on native
PostgreSQL 18. The component reports are in
`build/netlify-accounts-check-1792254284929/`; the socket proof is
`build/http-viewer-v8-battle-ui-report.json`. All six migrations are rehearsed.
The full HTTP journey advances 10,076 frames across 2,115 requests and matches
the reference result, private digests and personal pictures. Its extended movie
uses the trusted clock fixture; an independent real database-clock case also passes.

The latest local advancing-request sample is 259 ms median and 276 ms p95 for
15 frames, with a 1,199 ms maximum. This is limited latency headroom and excludes
hosted latency. It does not qualify 1,000 players.

Earlier failed and interrupted checks are retained. An external cleanup removed
the active legacy database during `http-viewer-v4`; its receipt is in
`build/http-viewer-v4/external-retirement-incident.json`. New checks retain their
database under `build/qualification-postgres/`, with a project ownership lock
and active-owner marker. The completed final run stopped its owned server.
Some older raw databases were retired externally; their report directories now
state that in `raw-database-retention.json`. Reports and original earned saves
remain separate evidence.

`build/netlify-accounts-check-1792247707934/request-battles-http-report.json`
records an earlier complete neutral-input HTTP journey: 10,076 original frames,
2,062 HTTP requests across all cases, identical final digests/result, personal
pictures compared with an uninterrupted reference, and one-frame tap parity
while the peer supplies no controls. It covers actual SDK accounts, logout,
reply-loss idempotency, conflicting retries, competing/replaced writer claims,
worker failure, a SQL timeout at receipt insertion, real database-clock smoke,
disconnect timeout and atomic lobby return. The recorded match uses an explicit
trusted clock fixture; the real-clock smoke is separate. No HTTP field grants
clock credit. The broader native batch subsequently found a solo form refresh
failure, so its component reports must not be represented as an overall pass.

After fixing the form race, an earlier combined account/main-UI/WebSocket suite
passes in `build/netlify-accounts-check-1792249987306/report.json`. The release
also verifies that this independent HTTP report's nine source hashes still
match. Four hosted solo gameplay checks and public API checks pass in
`build/netlify-accounts-release-1792250149/report.json`; they do not qualify
hosted HTTP battles.

The original peer-stall failure is retained in
`build/netlify-accounts-check-1792247582330/request-battles-http-failure.json`.
Earlier successful versions waited for both input queues and are superseded
for this fairness behavior. All source hashes and failed evidence are retained.

The earlier cold local advancing requests sampled 265 ms median and 288 ms p95 for 15
frames. Both samples leave limited performance headroom and exclude hosted latency.
The Netlify adapter needs measured artifact-cache reuse, digest scheduling and
checkpoint/database cost before public play.

Before public admission, qualify the viewer and failure matrix on the hosted
Function; improve and measure advancing latency;
add bounded deployment admission and receipt-retention policy; and measure
network latency, playback, audio and physical devices. Existing solo progress
still needs its explicit promotion policy. Complete game/mechanics, DS,
cross-generation conversion and 1,000-player capacity gates remain separate.
