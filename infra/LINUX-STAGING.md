# Linux staging package

This is a private staging package toward hosted accounts and the eventual
1,000-player service. The Netlify solo preview stays separate. No paid server,
database, cache or bucket has been created. No image/container has been built
or run on this Mac; Colima remains held off.

## Concrete package

- `api.Dockerfile` pins the public Node 24 image by digest and installs only the
  server workspace's production dependencies, using the existing lockfile and
  disabled install scripts. The runtime runs as UID/GID 1000.
- `compose.staging.yml` configures one API with process workers, two CPU units,
  a 4 GiB memory limit, no additional swap, a 192-process/thread ceiling,
  read-only root/artifact mounts, dropped capabilities, no privilege escalation
  and a small temporary filesystem. Logs are bounded.
- The API port binds only to host loopback for initial operator qualification.
  A reviewed HTTPS/WebSocket ingress and exact trusted-proxy settings are still
  needed before connecting a hosted frontend. This profile is not public ingress.
- `PUBLIC_RELEASE=false` and process transport are fixed in the profile even
  when the private runtime env file contains conflicting values. Original
  artifact admission and public-release checks remain unchanged.

The optional [HTTPS overlay](HTTPS-STAGING.md) now adds pinned Caddy ingress
for this single-API profile. Its native HTTPS/WSS and offline Compose checks
pass; public certificate issuance and Linux execution are still unverified.

The resource limits cover the API and all its child workers together. Children
retain the same container user, filesystem and network namespace as the API;
this is not a separate permission sandbox or individual memory cap per game.
Linux kernel enforcement and original-game load still require verification on
the chosen host. Docker documents the
[memory/swap/CPU semantics](https://docs.docker.com/engine/containers/resource_constraints/)
and [Compose settings](https://docs.docker.com/reference/compose-file/services/).

## Source archive and first boot

The separate [gateway profile](GATEWAY.md) defines two APIs behind one gateway.
It is a standalone Compose file and has its own operator/Auth-only env examples
and offline checker. Its combined configured memory ceiling is 8.5 GiB plus
host overhead, so the single-API 8 GiB proposal below does not size that profile.
No multi-service Linux boot or capacity qualification has been performed.

Create an explicit server-only build context through the local resource guard:

```sh
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- python3 -B scripts/package-api-context.py --output build/your-fresh-api-context.tar
```

The deterministic tar contains server/package TypeScript, the workspace
manifests and lockfile, Dockerfile and runtime inspector. It excludes dependency
folders, browser code, test fixtures, local credentials, ROMs, WASM artifacts,
saves and checkpoints. Only the web workspace manifest is included so npm can
resolve the existing workspace lockfile. Symlinked runtime sources and existing
output paths are refused. Preserve the adjacent SHA-256/file manifest.

After a Linux runner/host and its cost are authorized, transfer the context and
manifest, verify their hashes, and build from the archive:

```sh
# Linux host only; use the manifest's SHA-256 as the label/tag below.
docker build -f infra/api.Dockerfile --build-arg SOURCE_SHA256=YOUR_CONTEXT_SHA256 -t kanto-api-staging:YOUR_CONTEXT_SHA256 - < your-fresh-api-context.tar
```

Use copies of `staging.env.example` and `runtime.env.example` outside the
checkout. The runtime file contains only the dedicated Kanto Supabase URL,
publishable key and restricted transaction-pooler connection string; keep it
mode 0600. Its raw format preserves literal values without adding quotes.
Provision the database, confirmed-email Auth and verified sender through
[STAGING.md](STAGING.md) before account acceptance.

Create a separate reviewed artifact directory readable by UID 1000. It may
initially be empty for liveness/account setup. The existing experimental
candidates remain outside the production registry; their capability flags
remain false. An empty/unqualified registry keeps game admission and readiness
unavailable. A healthy HTTP process does not qualify gameplay.

```sh
docker compose --env-file /etc/kanto/staging.env -f infra/compose.staging.yml config --quiet
docker compose --env-file /etc/kanto/staging.env -f infra/compose.staging.yml up --detach --wait --wait-timeout 45
docker compose --env-file /etc/kanto/staging.env -f infra/compose.staging.yml exec -T api node --experimental-strip-types infra/inspect-linux-runtime.ts
```

Use Compose 2.30 or newer. Validate real configuration with `--quiet`; rendered
configuration includes runtime credentials. The HTTP healthcheck uses liveness,
so a database outage does not cause repeated process restarts. Check `/readyz`
separately before admitting players. The inspector reads actual cgroup-v2,
UID/capability and mount settings; it does not itself exercise OOM behavior or
measure game capacity. The profile gives shutdown 30 seconds; abrupt loss uses
the separately qualified durable-journal/lease recovery path.

## Checks available now and in Linux CI

The local packager tests inspect actual tar contents, including excluded-data
fixtures, source symlinks, deterministic hashes and preservation of old outputs.
The runtime-inspector unit check rejects unbounded/mismatched observations.
The offline Compose check uses dummy values and an unusable Docker endpoint:

```sh
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- python3 -B scripts/check-staging-config.py --tag your-fresh-staging-check
```

It validates actual Compose output, required operator inputs, fixed release
settings, mounts, loopback binding and configured limits. Compose's config
printer doubles dollar signs for re-interpolation; this representation is
checked separately from the actual container environment. No real env file,
Docker daemon or image is needed for this check.

The `container-runtime` GitHub Actions job builds the archive on Ubuntu, boots
this profile with dummy credentials and a test-only read-only fixture mount,
checks the production main entry's liveness, observes actual Linux settings and
runs private worker crash/recovery tests inside the container. It also checks
the runtime env value rather than inferring it from rendered JSON. This job has
been prepared but has not been pushed or run. Its successful result is still
required before claiming Linux image/runtime qualification. It does not qualify
original-C gameplay, hosted Auth, container OOM recovery or global capacity.

## Cost proposal and remaining sizing

Prices checked October 16, 2026; calculations are retained in
[`cost-plan.json`](cost-plan.json). None is spending authorization.

That original proposal covers the single-API profile. The separate two-API
gateway profile needs more than 8 GiB. Its [October 17 proposal](GATEWAY-COST.md)
uses 16 GiB/8 vCPU catalog options and keeps its qualification budget separate
from the illustrative 1,000-player arithmetic below.

| Private staging component | Published starting USD/month |
| --- | ---: |
| DigitalOcean Basic Regular: 4 shared vCPUs, 8 GiB | $48 |
| Dedicated Supabase Pro organization with one Micro project | $25 |
| Core starting subtotal | **$73** |

The host is a proposed small qualification target, not a measured capacity
recommendation. It leaves host/OS room outside the 4 GiB API container. SMTP,
domain, Netlify usage, taxes and additional metered services are excluded.
Published sources: [DigitalOcean](https://www.digitalocean.com/pricing/droplets),
[Supabase](https://supabase.com/pricing).

For the full 1,000-player goal, an illustrative budget example is four
General Purpose hosts with 32 dedicated vCPUs/128 GiB each ($4,032/month),
Supabase Pro plus XL compute after its compute credit (about $225/month),
Valkey primary plus standby (from $60/month), and base Spaces ($5/month):
**about $4,322/month before ingress, email, frontend usage, disk/IO/retention,
traffic, tax and operational extras**. This catalog arithmetic is not a sized
production configuration, complete quote or verified capacity. Sources:
[host catalog](https://www.digitalocean.com/pricing/droplets),
[database compute](https://supabase.com/docs/guides/platform/compute-and-disk),
[Valkey](https://docs.digitalocean.com/products/databases/valkey/details/pricing/),
[Spaces](https://www.digitalocean.com/pricing/spaces-object-storage).

The measured M4 Pro CPU costs do not establish cloud-vCPU performance, and
summed process RSS is not physical RAM per player. The current 32-worker
per-pool ceiling would require at least 32 API replicas for 1,000 adventures;
this one-API staging profile supplies neither those replicas nor their routing.
Redis-compatible routing, global admission, private object storage, retention,
regional network/database load and failure qualification remain required.
Supabase compute is hourly, so its monthly amount also varies with month length.
The dedicated project, verified sender and infrastructure budget remain pending.
