# HTTPS for the hosted account test

`compose.https.staging.yml` overlays the single-API `compose.staging.yml`.
It adds a pinned official Caddy 2.11.7 image, HTTPS and WebSocket forwarding
without adding another paid service. It is not a gateway or CI overlay.

Only ingress ports 80/443 are public. They map to unprivileged container ports
8080/8443. The API retains its loopback-only 8787 binding. Both services join a
dedicated bridge; the API trusts only the ingress's configured `/32`, not the
whole network. Caddy's standard forwarding replaces untrusted incoming
forwarded-header values. Do not add a CDN or another proxy without reviewing
that trust chain. See [Caddy proxy behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Ingress runs as UID/GID 1000 with a read-only root, dropped capabilities,
512 MiB memory, no additional swap, 0.5 CPU and bounded logs. It receives no
database/Auth runtime file and has no game-artifact mount. The API plus ingress
memory ceilings total 4.5 GiB, within the proposed 8 GiB host before measured
host overhead. The original API limits and release gates remain unchanged.

## Setup on the selected Linux host

Use this only after hosting, cost and domain selection. Follow
[Linux setup](LINUX-STAGING.md) and [account/database setup](STAGING.md) first.
The local Mac's Colima hold remains in effect.

1. Point the approved exact API hostname's DNS to that host. Publish an AAAA
   record only if IPv6 routing and firewall behavior are verified. Public
   certificate issuance needs reachable HTTP/HTTPS and persistent TLS storage.
   See [automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https).
2. Put the reviewed `Caddyfile.staging` at `/etc/kanto/Caddyfile.staging`, readable
   by UID 1000. Pre-create `/srv/kanto/tls` on this dedicated host, owned by
   UID/GID 1000 and mode 0700. This is retained certificate/account data; do not
   delete it during restarts or redeploys. Bind mounts refuse implicit creation.
3. Add the fields from `https-staging.env.example` to the existing private
   `/etc/kanto/staging.env`. Choose an unused subnet and an ingress IP inside
   it. Set one exact approved DNS hostname, without scheme, port, path or
   wildcard, and an approved ACME contact email. Do not use `.example` values.
4. Keep the API runtime file separate and mode 0600. Set `KANTO_WEB_ORIGIN` to
   the exact hosted client origin. Build that client with `VITE_API_URL` equal
   to `https://YOUR_API_HOSTNAME`; configure the exact confirmation and recovery
   redirects in the dedicated Auth project. Runtime credentials stay private.

Validate real configuration with `--quiet`, since printed Compose configuration
contains the API credentials. On the selected Linux host:

```sh
docker compose --env-file /etc/kanto/staging.env -f infra/compose.staging.yml -f infra/compose.https.staging.yml config --quiet
docker compose --env-file /etc/kanto/staging.env -f infra/compose.staging.yml -f infra/compose.https.staging.yml up --detach --wait --wait-timeout 60
```

`--wait` establishes API liveness and a running ingress process; Caddy has no
separate Compose healthcheck. Inspect its bounded logs and test real HTTPS
explicitly. The admin API is disabled, so apply config changes by a planned
ingress restart. This closes active sockets; pause play before changes and
verify normal saved-session recovery afterward.

Check public `/healthz`, `/api/status`, certificate chain/hostname, HTTP
redirects and actual browser WSS. `/readyz` must remain 503 with unqualified or
missing game artifacts. A working TLS endpoint does not qualify game admission.
Verify direct remote access to 8787 is blocked and API rate limiting distinguishes
real remote clients while rejecting forwarded-IP spoofing. Container execution,
network isolation, cgroups and persistent-directory ownership require actual
Linux checks; the native test below does not prove them.

## Available local evidence

Run a fresh, finite tag through the guard, with the official Caddy 2.11.7
binary available at an explicit local path:

```sh
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/check-https-ingress.ts your-fresh-tag /absolute/path/to/caddy
```

The check uses Compose's real parser with fake values and an unusable Docker
endpoint; it starts no container. It verifies fixed proxy trust, alternate
subnet settings, missing required inputs, mounts, published ports and limits.
The actual Caddyfile is adapted/validated by native Caddy. A local run replaces
only its listeners, upstream address and certificate provisioning, using a
fixture certificate explicitly trusted by the test client. It installs no
system CA and contacts no public certificate authority.

Through that proxy, the real API preserves unready responses, no-store headers,
forwarded client identity and wrong-origin WebSocket rejection. Fixture routes
check exact mutation text/query forwarding, no retry after a dropped response,
and a binary WSS roundtrip. Changing fake client-IP headers still hits the real
API's rate limiter. The owned API and Caddy stop after the check.

`build/ingress-v2-https/report.json` and `build/https-ingress-check-v2.log` retain
the passing native/Compose/type checks. The local executable's official archive
matches its published SHA-512 checksum; provenance is in
`build/tools/caddy-2.11.7/source.json`. The original download-check script and initial TypeScript failure log are
retained; no evidence was removed. Public ACME, Linux
containers, hosted signup, original-game play and 1,000-player capacity remain
unqualified. No provider or billing setting changed.
