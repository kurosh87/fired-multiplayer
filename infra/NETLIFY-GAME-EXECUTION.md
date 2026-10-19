# Request-driven original-C game execution

The public site currently hosts accounts and solo play on Netlify. The existing
multiplayer API uses persistent HTTPS/WebSocket processes. A second transport
now executes bounded original-C work over native HTTP and persists progress
between requests. The [HTTP implementation](REQUEST-BATTLE-API.md) is qualified
locally, including the desktop/mobile viewer and durable tab ownership on
PostgreSQL 18; its Netlify wrapper and public viewer are not deployed.

Netlify functions run in ephemeral environments; correctness cannot depend on
one invocation retaining a console. Streaming responses also have a 60-second
execution limit and a 20 MB response limit. Background handlers immediately
return 202 and discard their return value, so they do not directly provide an
interactive match stream. See the [Functions overview](https://docs.netlify.com/build/functions/overview/)
and [Functions API](https://docs.netlify.com/build/functions/api/).

## Measured recovery experiment

`scripts/check-request-battle-recovery.ts` replays a complete recorded original-C
FireRed/LeafGreen match in 60-frame segments. It terminates the worker after
each segment, then installs the pinned artifacts and restores both consoles in
a fresh worker. It checks both memory digests at every restore, decodes each
player's own screen packets, and compares the final result and digests with the
recorded match. Original cartridge hashes remain unchanged.

Evidence: `build/request-battle-recovery-v1/report.json`.

| Local measurement | Result |
| --- | --- |
| Full match | 10,076 frames; 168 fresh workers |
| Restore time | 149 ms median; 155 ms p95 |
| Segment computation before teardown | 308 ms median; 317 ms p95 |
| Compressed checkpoint pair | 254,592–595,836 bytes |
| Largest estimated gzip screen response per player | 25,142 bytes |
| Replay, restore, screen and cartridge comparisons | Passed |

These are local single-match measurements, not hosted latency or capacity.
The response estimate compresses concatenated screen packets and excludes HTTP
framing, audio and database traffic. The experiment receives known recorded
inputs; it does not implement live input timing or admission. Checkpoints are
private server data, never viewer payloads.

Frequent checkpoint writes are a material design constraint. As a conditional
example, 500 matches each writing even the smallest measured pair once per
second would write about 121 MiB/s before database overhead. This arithmetic
does not establish achievable throughput. A temporary beta needs measured,
bounded admission; the 1,000-active-player target still needs its own mixed-load
qualification. Journal replay and less frequent checkpoints may reduce writes,
but must remain bounded and be measured against recovery latency.

## Required behavior of the adapter

1. Authenticate every request with the existing confirmed Better Auth identity.
   Resolve battle membership and side on the server. An account can supply its
   own button durations, never its opponent's controls, authoritative frame
   counter, seed or snapshot.
2. Read the pinned artifacts, durable checkpoint, decision state, journals and
   writer fence. Restore outside a long-running SQL transaction. Enforce a
   short computation deadline with an owned worker that can be terminated.
3. Keep clock credit in the database. Refilling from trusted database time,
   capping accumulated credit, and debiting actual advanced frames must survive
   cold starts. Recreating a function must not grant another startup allowance.
   Preserve fractional credit and handle clock reversal without minting time.
4. Apply the existing original-C decision gates and deadlines. Two concurrent
   requests must not advance the same interval twice or reveal a pending choice.
   Idle menus, held-button transitions and reconnection require explicit tests.
5. Commit the journal, checkpoints or bounded replay prefix, clock, decision
   state, outcome and idempotency receipt atomically, conditional on the exact
   previous revision/fence. Discard stale computation after a failed compare.
   Acknowledgement follows durable commit; response loss returns the same
   receipt. Reusing an operation ID with different input must fail.
6. Serve only the authenticated player's screen sequence. Start each independent
   response with a keyframe and maintain delta order within it. Handle duplicate,
   delayed and reordered responses explicitly. Never send private console
   memory, the other screen, controller buffers or pending choices.
7. Use bounded database pools, payloads, request queues and per-account admission.
   Measure both first-byte latency and smooth playback on actual mobile devices.
   A warm artifact/module cache may improve latency but cannot be required for
   correct recovery. Bundle worker code and pinned assets explicitly.

The native authenticated HTTP journey now completes the original match,
including independent personal pictures, lost replies, competing/replaced
claims, worker failure, SQL receipt-write timeout and unchanged cartridges.
A reproduced peer-input stall was fixed by applying neutral missing controls.
The latest complete HTTP proof is
`build/netlify-accounts-check-1792247707934/request-battles-http-report.json`.
That full native batch later found an unrelated solo account-form refresh race;
the standalone HTTP report records its own completed checks and source hashes.

The cold local HTTP sample advances 15 original frames in 265 ms median and
288 ms p95. This is correctness evidence with limited latency headroom, not a
production performance claim. Warm artifact caching, digest scheduling,
checkpoint traffic and actual hosted latency need measurement. Next qualify
the wrapper and current viewer on a Netlify preview, followed by
audio, network interruption and bounded concurrency before public admission.

The current full qualification is `build/http-viewer-v8/report.json`, with
component reports in `build/netlify-accounts-check-1792254284929/`. It verifies
the actual HTTP viewer, fair writer handoff, preservation of taps during busy
responses, stale-tab rejection, authenticated presence and the original socket
path. Its local 15-frame sample is 259 ms median, 276 ms p95 and 1,199 ms maximum;
this remains insufficient evidence of hosted performance. Read-only inspection
finds PostgreSQL 18.6 on both Netlify branches and reproduced a missing preview
SET-role permission. The additive sixth migration repairs it without giving
the account role game access. Production deploy `6ad3a4e3ce306ae83fa3e14d` applies
all six migrations; `build/netlify-accounts-release-1792255070/` retains the
hosted restricted-role and catalog verification. The newer
[private battle Function](NETLIFY-BATTLE-FUNCTION.md) passes a hosted preview
journey. Its initial latency remains too high for public play; a locally
qualified idle-worker optimization is awaiting a successful preview build.

Verified adventure and trade execution also need request-driven adapters if the
whole main application stays on Netlify. Existing solo saves need an explicit
promotion policy that preserves their progress and provenance. The experiment
does not resolve either requirement or admit uploaded achievement history.

The same account, adventure UUID and durable records should be retained when
moving execution to the existing persistent transport on OrangeHost later.
