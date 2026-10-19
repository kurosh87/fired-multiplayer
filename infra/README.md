# Deployment status

Netlify hosts the temporary solo browser preview. No hosted account/database
or authoritative multiplayer backend has been provisioned for Kanto. The
current server refuses `PUBLIC_RELEASE=true`.

The concrete next step is the [private Auth/database staging setup](STAGING.md),
including current starting prices, SMTP requirements and hosted account acceptance.

The [Linux staging package](LINUX-STAGING.md) now supplies a pinned Node image
recipe, explicit server-only context archive, bounded non-root Compose profile,
offline configuration check and a prepared Linux CI job. Its configuration is
checked locally; the image and Linux runtime have not been built or run. The
proposed private staging core starts at $73/month before email, frontend usage
and extras. [Cost inputs](cost-plan.json) also retain an illustrative partial
budget for the full goal; they are not a qualified capacity quote or approval
to provision resources.

The intended deployment keeps the web client on Netlify, with a separate
WebSocket-capable API/game service, isolated game workers, Redis presence/session
routing, Supabase Auth/Postgres and private object storage for compressed
checkpoints and replay archives. The API hosting target still needs measured
sizing and a costed selection; Netlify's static preview does not host these
long-lived verification connections.

## Backend health and reverse proxies

`GET /healthz` checks API liveness without querying Postgres. Use it to detect
a stopped process. `GET /readyz` requires configured account integration,
explicit available statuses for both editions and a successful Postgres ping.
It returns 503 if the pool cannot query. These probes do not verify migration
state, actual Auth/email delivery, experimental artifact qualification or
1,000-player capacity. A live API can remain unready during a database outage;
restarting it repeatedly does not repair the database. Idle Postgres connection
errors are handled, and pg removes the dead client before reconnecting on demand.

Leave `TRUST_PROXY_CIDRS` empty for direct connections. Behind a reverse proxy,
set only that ingress's actual IPs or subnet CIDRs, separated by commas. For
example, a single local TLS proxy can use `127.0.0.1/32,::1/128`. Forwarded
addresses from other peers are ignored; trusted chains stop at the nearest
untrusted hop. Boolean/hop-count trust and whole-address-space CIDRs are refused.
This preserves per-client limits behind ingress without accepting a direct
client's spoofed address. The hosting provider must supply its actual ingress
network; do not copy a broad example network into production.

`tests/server-hosting.test.ts` covers proxy boundaries, per-client limits,
artifact/config readiness and database failure responses. Run
`KANTO_CHECK_HOSTING_READINESS=1` with `scripts/check-database.py` through the
project guard for the actual disposable-Postgres check: it retires only its
newly created idle pool connection, verifies recovery, then checks 503 after
closing its own pool. Set a fresh `KANTO_HOSTING_READINESS_EVIDENCE_TAG` to
retain subsequent reports. This does not touch a hosted database or the held VM.

The local API restart qualification now covers both original-game adventures
across an API SIGKILL, real lease expiry and SIGTERM. Shutdown revokes the
writer fence so a late disconnect checkpoint cannot renew a released lease.
See [restart implementation and evidence](../engine/WORKERS.md#api-process-restart-and-shutdown-fences).
An abrupt loss still requires the existing lease to expire (up to a minute);
this check does not supply distributed routing or immediate crash failover.

Do not publish the current session manager as a 1,000-player service. Adventure verification, battles, trade scenes, trade eligibility and lobby-party inspection now use bounded local pools, with thread or process transport. Process mode supplies separate child address spaces and parent-loss cleanup; host/container RSS limits and permission isolation remain unqualified. Prototype checkpoints remain in Postgres. Authenticated battle/trade adapters are locally qualified, while public capability flags remain disabled. Cross-machine routing and measured mixed process-mode workloads are still required. See [worker implementation and evidence](../engine/WORKERS.md).

Before infrastructure sizing, collect simulation throughput and RSS per active game, mixed-world/battle CPU, durable input throughput, checkpoint sizes and restore times, WebSocket traffic, and 95th-percentile verification acknowledgement latency. Produce a costed configuration with 1,000 active adventures and a separate mixed battle/trade workload; qualify it under worker failures before enabling public registration/play.

Use separate staging and production projects and retain exact game artifacts while their sessions are recoverable. Runtime credentials belong in the hosting platform's secret manager. Neither `.env` nor cloud credentials belong in source control.
