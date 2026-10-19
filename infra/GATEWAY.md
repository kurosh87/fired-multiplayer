# Routing across API instances

The gateway in `apps/server/src/gateway-main.ts` routes HTTP and WebSocket
connections to a fixed set of logical API workers. It verifies the account
through Auth before selecting a private route. The destination API independently
checks the account, confirmed email, profile and suspension status. Routing does
not grant access to a session or battle.

| Request | Routing key |
| --- | --- |
| Adventure bootstrap, checkpoint, controls and lobby | Verified account UUID |
| Trade invitations, offers and each player's trade scene | Verified account UUID |
| Battle challenge creation and challenge list | Verified account UUID |
| Battle accept, open, get, decline and forfeit | Battle UUID |
| Both players' battle controls and screens | Battle UUID |
| Public status, manifests and game downloads | Public request path |

Rendezvous hashing uses stable logical node IDs. Reordering the configuration
does not move keys. Client headers, editable account metadata and supplied
owner IDs cannot select a worker. A battle's two players reach the same API
even when their adventure and lobby services run on different APIs.

## Operator setup

`gateway.env.example` is a placeholder configuration, not a deployment. Each
worker must use the same dedicated Auth project, database and admitted game
artifacts. Give each worker a unique private origin and stable logical ID. Keep
backend origins inaccessible to public clients. Use exact IP/CIDR trust on the
APIs for the gateway's immediate address; otherwise API rate limiting will see
every player as the gateway's IP. Do not trust client-supplied forwarded headers.

For an already provisioned host, the entry command from the repository root is:

```sh
node --env-file=/etc/kanto/gateway.env --experimental-strip-types apps/server/src/gateway-main.ts
```

The existing server image includes this entry, but its default command still
starts one API. The standalone `compose.gateway.staging.yml` now defines two
APIs and the gateway, using that same reviewed image. It configures each API
with 2 CPU units, 4 GiB memory and 192 PIDs, and the gateway with 1 CPU unit,
512 MiB and 64 PIDs. All use read-only root filesystems, non-root users, dropped
capabilities and no additional swap. Linux execution/enforcement and workload
sizing are still unverified. These are configured ceilings, not measured
capacity. Their combined 8.5 GiB memory ceiling does not fit the earlier 8 GiB
host proposal with adequate headroom. The [private gateway cost proposal](GATEWAY-COST.md)
uses 16 GiB host options and keeps that small test budget separate from
1,000-player sizing. No larger host or paid runner has been selected.

Put HTTPS/WSS ingress in front of the gateway and configure only that ingress's
immediate addresses in the gateway's `TRUST_PROXY_CIDRS`. Set `WEB_ORIGIN` to the
exact hosted frontend origin on the gateway and every API; build the frontend
with `VITE_API_URL` pointing to the public gateway origin. No secret database
URL or privileged Auth key belongs in the browser. Supabase mode uses public
Auth settings. The new [Better Auth adapter](BETTER-AUTH-MULTIPLAYER.md) instead
uses a private account database pool, separate from game-data credentials;
that hosted mode still needs qualification.

`/healthz` checks the gateway process. `/readyz` requires every configured API
to be ready and to advertise the same manifest ID/hash for both admitted
adventure editions. It does not establish shared database identity, Auth
configuration equivalence, battle artifact equivalence, SMTP delivery, Linux
resource enforcement or release qualification. Private experimental providers
retain false admission flags and must still return unready.

## Standalone private Compose profile

Use `gateway-staging.env.example` for the operator settings, the existing
`runtime.env.example` for the APIs, and `gateway-runtime.env.example` for the
gateway's separate Auth-only file. Keep the runtime files outside the checkout
with mode 0600. The profile overrides accidental database settings on the
gateway to an empty string; it does not mount game artifacts there.

Only gateway port 8788 is published, on host loopback. The two APIs share a
project bridge with outbound access to Auth and Postgres, and publish no host
ports. The gateway has a fixed private IPv4 address so the APIs trust exactly
that `/32`. Choose an unused private subnet and an address inside it in the
operator file; change both together. Offline validation cannot detect conflicts
with the chosen host's existing networks. Neither API joins the ingress bridge.
See Docker's [networking guide](https://docs.docker.com/compose/how-tos/networking/)
and [service configuration reference](https://docs.docker.com/reference/compose-file/services/).

Render the exact profile with the real Compose parser and synthetic settings:

```sh
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- python3 -B scripts/check-gateway-staging.py --tag your-fresh-tag
```

This uses a deliberately unreachable Docker endpoint and never reads real
credentials. It checks missing operator settings, exact proxy trust, alternate
subnet configuration, fixed routing, private API ports, artifact mounts and
resource settings. It cannot prove container execution or network isolation.

Once an appropriate Linux host/runner, host budget and dedicated account
service are configured, build the explicit source archive as described in
`LINUX-STAGING.md`, then use the standalone profile:

```sh
docker compose --env-file /etc/kanto/gateway-staging.env -f infra/compose.gateway.staging.yml config --quiet
docker compose --env-file /etc/kanto/gateway-staging.env -f infra/compose.gateway.staging.yml up --detach --wait --wait-timeout 60
docker compose --env-file /etc/kanto/gateway-staging.env -f infra/compose.gateway.staging.yml exec -T gateway node --experimental-strip-types infra/inspect-linux-runtime.ts gateway
docker compose --env-file /etc/kanto/gateway-staging.env -f infra/compose.gateway.staging.yml exec -T api-alpha node --experimental-strip-types infra/inspect-linux-runtime.ts api
docker compose --env-file /etc/kanto/gateway-staging.env -f infra/compose.gateway.staging.yml exec -T api-bravo node --experimental-strip-types infra/inspect-linux-runtime.ts api
```

Do not merge this file with the single-API staging or CI overlay. Do not change
the topology while players are active, or scale multiple replicas behind one
logical API name: requests could reach different resident workers. `up --wait` checks liveness, so inspect
`/readyz` separately; unadmitted artifacts must still return 503. Runtime
inspection checks observed UID, capabilities, mounts and cgroup settings, not
OOM behavior or load capacity. Verify actual raw env values, outbound access,
private API reachability, shutdown and the original-game journey on that Linux
host before adding a public HTTPS/WSS ingress.

## Connection and failure behavior

The first WebSocket message must authenticate within 10 seconds. The Auth
request has a 5-second deadline; connection to the selected worker has a
5-second deadline within the initial authentication window. Ongoing credential
renewal messages pass through to the owning service. Both relay halves use
ping/pong heartbeat cleanup.

HTTP proxying preserves raw mutation JSON and streams responses. Headers must
arrive within 10 seconds; the complete transfer has a 300-second limit. The
gateway never retries a mutation after an ambiguous response. The application
must reconcile durable state through its existing recovery/idempotency paths.
Private responses remain uncached; admitted hash-addressed game files retain
their existing cache headers.

WebSocket input messages are limited to 16 KiB, upstream messages to 512 KiB.
If the destination already has more than 512 KiB queued, the relay closes with
1013 so the client can recover; one additional accepted packet can exceed that
threshold. It never drops encoded battle deltas. Shutdown closes both relay
halves with 1001 and aborts outstanding HTTP transfers.

Topology is static. Adding/removing a logical node moves some keys and requires
a deliberate drain and durable lease recovery. Do not change topology while
players are active. Replacing a failed process behind the same logical origin
keeps routing stable, but cannot bypass database fencing or lease expiry.
There is no automatic failover, live reassignment, global admission controller
or Redis directory yet. Public reads also use a fixed worker and can fail
when that worker is down, even if another node is healthy.

## Local qualification

Unit and real-socket fixture checks live in `tests/gateway-routing.test.ts`,
`tests/gateway.test.ts` and `tests/auth-deadline.test.ts`. They exercise stable
routing, origin/auth rejection, raw bodies, binary frames, artifact mismatch,
backpressure, shutdown and lack of mutation retries.

`tests/gateway-main.test.ts` also starts the real production entry in a separate
Node process through an env file. With isolated fixture backends/Auth it checks
HTTP, WebSocket relaying, readiness, literal env values and SIGTERM closure.
Invalid configuration and `PUBLIC_RELEASE=true` must fail before listening or
contacting Auth. This is native Node evidence; it does not execute the Docker
image or qualify hosted credentials.

The separate original-game check runs two actual API OS processes, their
private process workers and the gateway against a retained, dedicated database
in the project-owned native PostgreSQL cluster:

```sh
KANTO_GATEWAY_EVIDENCE_TAG=your-fresh-tag python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- python3 -B scripts/check-database.py --gateway
```

It continues retained input-earned checkpoints for both editions, verifies
HTTP checkpoint and WebSocket digests, restarts the gateway with reordered
configuration, and checks idempotent recovery. It then enters both lobbies,
exchanges trade offers across nodes, and accepts a source-built original battle
with both viewers on the selected node. Battle screens use the real binary
decoder; a deliberate forfeit checks that canonical saves remain unchanged.
Finally, it drives both original trade scenes through separate APIs at the real
game clock. An independent local original-C copy checks every acknowledged
digest. Only both completed scenes may commit the two saves; readback verifies
the exchanged, distinct caught Pokémon, preserved starters, one revision
increment per save and idempotent finish receipts. The battle is ended by
forfeit rather than played to its natural conclusion. Auth is an isolated
confirmed-account fixture, not hosted signup/email. This does not prove multiple
physical hosts, browsers, Internet latency, 1,000-player capacity or deployment.
Inspect the fresh report/log for actual outcomes; the command alone is not proof.

Set `KANTO_GATEWAY_BATTLE_TEXT=1` on this private test command to use the repaired
`battle-text-audio-16` adventure/trade cores and the input-earned first-gym
checkpoints. This requires finalized Brock browser/native-save evidence for both
editions. It checks that the trade preserves badges, TM39, money, the starter's
complete party bytes and PC storage, and increments the original trade counter
exactly once. The opt-in belongs to the test entry; it cannot admit experimental
artifacts into the production registry. Battle viewers still use the separately
retained linked-battle core, and this integration ends that battle by forfeit.

After a successful run, independently load its exact committed cartridges in
the checksum-matching original GBA games:

```sh
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/check-gateway-readback.ts your-fresh-tag
```

The separate readback report binds the unchanged gateway report by hash. It
checks Continue, every party and storage byte, and the selected earned progress
in original GBA RAM. Both commands require fresh evidence paths and preserve
their outputs. They do not establish full-game parity or hosted account play.

Scene checkpoints and worker retirement share a per-scene lock. Disconnect,
reopen and shutdown wait for an in-flight checkpoint's database write before
releasing its worker; a stale disconnect cannot delete a replacement runtime.
A durable receipt also retires a local runtime when another API committed the
trade. Deterministic lifecycle tests cover these races, and the original-game
gateway check rejects API error logs through graceful shutdown.

The owned cluster is stopped by the launcher on every terminal outcome.
Evidence databases, source identities and reports are retained for inspection.
